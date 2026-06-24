import json
from config import settings
from schemas import TopicInput, TopicOutput
from lib.prompt_registry import PromptVersion
from lib.log import get_logger, timed
from lib.llm import chat
from lib.model_router import TaskType

log = get_logger("agent.topic")


SYSTEM_PROMPT = """You are a YouTube short-form content strategist.
Given a niche, pick exactly ONE highly shareable video idea that:
- Can be delivered in 60-90 seconds of narration.
- Has a concrete, specific angle (not generic).
- Hooks the viewer in the first sentence with curiosity or a bold claim.
- Write title, angle, rationale, and a trend_score (0.0 to 1.0) in the requested target language code.

If past topics from the same operator are supplied with performance data:
- Lean TOWARD patterns that were tagged "strong" (high CTR, high avg view %).
- Lean AWAY from patterns tagged "weak".
- Do NOT repeat a past topic title verbatim.

Return only the JSON object the schema requests."""


RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "topic",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "title": {"type": "string", "description": "The video title, <= 80 chars."},
                "angle": {"type": "string", "description": "The specific take or twist the video will use."},
                "rationale": {"type": "string", "description": "Why this will perform for this niche."},
                "trend_score": {
                    "type": "number",
                    "description": "Estimated short-term trend strength 0-1.",
                },
            },
            "required": ["title", "angle", "rationale", "trend_score"],
        },
    },
}


def _past_block(payload: TopicInput) -> str:
    if not payload.past_topics:
        return ""
    lines = ["\n\nPast runs in similar niches (use as signal, don't copy):"]
    for p in payload.past_topics:
        parts = [f'- "{p.topic_title}" — {p.topic_angle}']
        if p.performance_tag:
            parts.append(f"tag={p.performance_tag}")
        if p.views is not None:
            parts.append(f"views={p.views}")
        if p.ctr is not None:
            parts.append(f"ctr={p.ctr:.1%}")
        if p.avg_view_pct is not None:
            parts.append(f"avp={p.avg_view_pct:.1f}%")
        lines.append(" | ".join(parts))
    return "\n".join(lines)


def _exclude_block(payload: TopicInput) -> str:
    if not payload.exclude_titles:
        return ""
    lines = ["\n\nDO NOT produce any of these titles (they already exist):"]
    for t in payload.exclude_titles:
        lines.append(f'- "{t}"')
    lines.append("Choose a materially different angle or subject.")
    return "\n".join(lines)


def run(raw_input: dict) -> dict:
    payload = TopicInput.model_validate(raw_input)
    log.info(
        "niche=%s language=%s past=%d",
        payload.niche,
        payload.language_code,
        len(payload.past_topics),
    )

    user_content = (
        f"Niche: {payload.niche}"
        f"\nTarget language code: {payload.language_code}"
        f"{_past_block(payload)}"
        f"{_exclude_block(payload)}"
    )

    with timed(log, "llm.chat", task="topic_generation"):
        response = chat(
            task_type=TaskType.TOPIC_GENERATION,
            prompt_version=PromptVersion.TOPIC_V1,
            temperature=0.9,
            response_format=RESPONSE_FORMAT,
            response_model=TopicOutput,
            use_cache=payload.use_cache,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
        )

    content = response.choices[0].message.content or "{}"
    data = json.loads(content)
    out = TopicOutput.model_validate(data).model_dump()
    log.info("chose title=%r trend_score=%.2f", out["title"], out["trend_score"])
    return out
