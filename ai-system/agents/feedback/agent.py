import json
from config import settings
from schemas import FeedbackInput, FeedbackOutput
from lib.log import get_logger, timed
from lib.llm import chat
from lib.model_router import TaskType

log = get_logger("agent.feedback")


SYSTEM_PROMPT = """You analyze short-form YouTube video performance and extract actionable lessons.
Given a single video's topic, hook, metadata, and analytics, produce three short paragraphs:

- what_worked: concrete elements likely responsible for what went right (hook phrasing, topic specificity, SEO overlap, etc.). Be specific — reference the actual text.
- what_didnt: concrete weaknesses visible in the data (low CTR → thumbnail / title; low avg view % → weak hook or pacing; low views → SEO / topic demand).
- suggestions: 2-4 pointed improvements for FUTURE runs (not this video). Directly usable by an AI content pipeline.

Also classify the run as:
  "strong" — CTR >= 4% AND avg_view_percentage >= 50
  "mid"    — between the two
  "weak"   — CTR < 2% OR avg_view_percentage < 25
  (Fall back to "mid" if metrics are missing or ambiguous.)

Return only the JSON object."""


RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "feedback",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "what_worked": {"type": "string"},
                "what_didnt": {"type": "string"},
                "suggestions": {"type": "string"},
                "performance_tag": {"type": "string"},
            },
            "required": ["what_worked", "what_didnt", "suggestions", "performance_tag"],
        },
    },
}


def run(raw_input: dict) -> dict:
    payload = FeedbackInput.model_validate(raw_input)
    m = payload.metrics
    log.info(
        "topic=%r views=%s ctr=%s avg_view_pct=%s",
        payload.topic_title,
        m.views,
        m.ctr,
        m.avg_view_percentage,
    )

    user_msg = (
        f"Niche: {payload.niche}\n"
        f"Topic title: {payload.topic_title}\n"
        f"Angle: {payload.topic_angle}\n"
        f"Hook used: {payload.script_hook}\n"
        f"Hook variants tried: {json.dumps(payload.hook_variants)[:800]}\n"
        f"Tags: {', '.join(payload.tags[:15])}\n\n"
        f"Metrics (use exact numbers):\n"
        f"- views: {m.views}\n"
        f"- impressions: {m.impressions}\n"
        f"- ctr: {m.ctr}\n"
        f"- avg_view_duration_sec: {m.avg_view_duration_sec}\n"
        f"- avg_view_percentage: {m.avg_view_percentage}\n"
        f"- watch_time_minutes: {m.watch_time_minutes}\n"
        f"- likes: {m.likes}\n"
        f"- comments: {m.comments}"
    )

    with timed(log, "llm.chat", model=settings.openai_model_quality):
        response = chat(
            task_type=TaskType.ANALYSIS,
            temperature=0.4,
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

    data = json.loads(response.choices[0].message.content or "{}")
    out = FeedbackOutput.model_validate(data).model_dump()
    log.info("tag=%s", out["performance_tag"])
    return out
