import json
from config import settings
from schemas import HookInput, HookOutput
from lib.log import get_logger, timed
from lib.llm import chat_with_fallback

log = get_logger("agent.hook")


SYSTEM_PROMPT = """You are a short-form-video hook specialist.
A hook must grab attention in the first 3 seconds. Strong hooks use:
- a concrete claim with a number
- a contrarian or counterintuitive statement
- a question that creates an open loop
- a pattern interrupt

Hard rules:
- Each variant is ONE sentence, <=20 words.
- No emojis, no stage directions, no hashtags.
- Must not misrepresent the script.
- Score 0-10 on probable 3-second retention strength. Explain briefly.
- Pick the best by chosen_index (0-based).

If past hooks from similar topics are provided with performance tags:
- Lean TOWARD structural patterns tagged "strong" (reuse the SHAPE, not the words).
- Avoid patterns tagged "weak".
- Do NOT copy past hooks verbatim.

Return only the JSON object the schema requires."""


def _response_format(n_variants: int) -> dict:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "hook_variants",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "variants": {
                        "type": "array",
                        "minItems": n_variants,
                        "maxItems": n_variants,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "text": {"type": "string"},
                                "score": {"type": "number"},
                                "reasoning": {"type": "string"},
                            },
                            "required": ["text", "score", "reasoning"],
                        },
                    },
                    "chosen_index": {"type": "integer"},
                    "chosen_text": {"type": "string"},
                },
                "required": ["variants", "chosen_index", "chosen_text"],
            },
        },
    }


def _past_block(payload: HookInput) -> str:
    if not payload.past_hooks:
        return ""
    lines = ["\n\nPast hooks from similar topics (signal, do not copy):"]
    for h in payload.past_hooks:
        parts = [f'- "{h.hook_text}"']
        if h.performance_tag:
            parts.append(f"tag={h.performance_tag}")
        if h.ctr is not None:
            parts.append(f"ctr={h.ctr:.1%}")
        if h.avg_view_pct is not None:
            parts.append(f"avp={h.avg_view_pct:.1f}%")
        lines.append(" | ".join(parts))
    return "\n".join(lines)


def run(raw_input: dict) -> dict:
    payload = HookInput.model_validate(raw_input)
    log.info(
        "topic=%r original_hook=%r variants=%d past=%d",
        payload.topic_title,
        payload.original_hook[:60],
        payload.variants,
        len(payload.past_hooks),
    )

    user_msg = (
        f"Topic title: {payload.topic_title}\n"
        f"Topic angle: {payload.topic_angle}\n"
        f"Original hook: {payload.original_hook}\n"
        f"Script body (context only, DO NOT include in hook):\n{payload.script_body}"
        f"{_past_block(payload)}\n\n"
        f"Produce EXACTLY {payload.variants} distinct hook variants, score each, and choose the best."
    )

    with timed(log, "openai.chat.completions", model=settings.openai_model_quality):
        response = chat_with_fallback(
            primary_model=settings.openai_model_quality,
            fallback_model=settings.openai_model_fast,
            temperature=0.9,
            response_format=_response_format(payload.variants),
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )

    usage = getattr(response, "usage", None)
    if usage:
        log.info(
            "tokens in=%s out=%s total=%s",
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.total_tokens,
        )

    data = json.loads(response.choices[0].message.content or "{}")

    # Trust the scores, not the model's claim: pick the argmax as a sanity net.
    variants = data.get("variants", [])
    if variants:
        scores = [v.get("score", 0) for v in variants]
        best_idx = max(range(len(scores)), key=lambda i: scores[i])
        claimed_idx = data.get("chosen_index", best_idx)
        if not (0 <= claimed_idx < len(variants)) or scores[claimed_idx] < scores[best_idx]:
            log.warning(
                "chosen_index %s overridden to argmax %s", claimed_idx, best_idx
            )
            data["chosen_index"] = best_idx
        data["chosen_text"] = variants[data["chosen_index"]]["text"]

    out = HookOutput.model_validate(data).model_dump()
    log.info(
        "chose idx=%d score=%.2f text=%r",
        out["chosen_index"],
        out["variants"][out["chosen_index"]]["score"],
        out["chosen_text"][:80],
    )
    return out
