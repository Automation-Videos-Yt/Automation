import json
from config import settings
from schemas import ViralHookInput, ViralHookOutput, TopPerformingHook
from lib.log import get_logger, timed
from lib.llm import chat_with_fallback

log = get_logger("agent.viral_hook")


SYSTEM_PROMPT = """You are a viral YouTube Shorts hook generator.

Goal:
- Maximize CTR.

You will receive:
- Topic
- Previous hook
- Top-performing hooks from memory

Task:
- Generate 3 improved hooks.

Every hook must:
- Create a curiosity gap.
- Include FOMO (fear of missing out).
- Use strong emotional triggers.
- Use fast-paced language.

Rules:
- Max 12 words per hook.
- The first 2 seconds must grab attention.
- Avoid generic phrasing.
- Do not copy memory hooks verbatim.

Output format (strict):
- Return ONLY a JSON array of exactly 3 strings.
"""


RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "viral_hooks",
        "strict": True,
        "schema": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {"type": "string"},
        },
    },
}


def _memory_hooks_block(payload: ViralHookInput) -> str:
    if not payload.top_performing_hooks_from_memory:
        return "(none)"

    lines: list[str] = []
    for item in payload.top_performing_hooks_from_memory:
        if isinstance(item, str):
            text = item.strip()
            if text:
                lines.append(f'- "{text}"')
            continue

        mem = TopPerformingHook.model_validate(item)
        text = mem.hook_text.strip()
        if not text:
            continue
        tag = f" (tag={mem.performance_tag})" if mem.performance_tag else ""
        lines.append(f'- "{text}"{tag}')

    return "\n".join(lines) if lines else "(none)"


def run(raw_input: dict) -> list[str]:
    payload = ViralHookInput.model_validate(raw_input)
    log.info("topic=%r memory_hooks=%d", payload.topic, len(payload.top_performing_hooks_from_memory))

    user_msg = (
        f"Topic: {payload.topic}\n"
        f"Previous hook: {payload.previous_hook or '(none)'}\n"
        f"Top-performing hooks from memory:\n{_memory_hooks_block(payload)}"
    )

    with timed(log, "openai.chat.completions", model=settings.openai_model_quality):
        response = chat_with_fallback(
            primary_model=settings.openai_model_quality,
            fallback_model=settings.openai_model_fast,
            temperature=0.9,
            response_format=RESPONSE_FORMAT,
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

    data = json.loads(response.choices[0].message.content or "[]")
    out = ViralHookOutput.model_validate(data).model_dump()
    log.info("generated_hooks=%s", out)
    return out
