import json
from config import settings
from schemas import ScriptInput, ScriptOutput
from lib.log import get_logger, timed
from lib.llm import chat_with_fallback

log = get_logger("agent.script")

WORDS_PER_SECOND = 2.5


SYSTEM_PROMPT = """You are a senior short-form video scriptwriter.
Produce a script structured as: HOOK (1-2 sentences, <=25 words), BODY (informational/entertaining main content), CTA (1 sentence).
Constraints:
- Narration should fit the target duration, assuming roughly 2.5 words per second.
- Hook must grab attention in the first 3 seconds (claim, question, or contrarian take).
- No stage directions, no markdown, no emojis.
- Body flows as spoken prose; avoid bullet lists.
Return only the JSON object the schema requests."""


RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "script",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "hook": {"type": "string"},
                "body": {"type": "string"},
                "cta": {"type": "string"},
                "word_count": {"type": "integer"},
                "duration_estimate_sec": {"type": "integer"},
            },
            "required": ["hook", "body", "cta", "word_count", "duration_estimate_sec"],
        },
    },
}


def _recompute_metrics(data: dict) -> dict:
    full = f"{data.get('hook', '')} {data.get('body', '')} {data.get('cta', '')}".strip()
    words = [w for w in full.split() if w]
    data["word_count"] = len(words)
    data["duration_estimate_sec"] = max(1, round(len(words) / WORDS_PER_SECOND))
    return data


def run(raw_input: dict) -> dict:
    payload = ScriptInput.model_validate(raw_input)
    log.info(
        "topic=%r duration_target=%ds", payload.topic_title, payload.target_duration_sec
    )

    user_msg = (
        f"Topic title: {payload.topic_title}\n"
        f"Topic angle: {payload.topic_angle}\n"
        f"Target duration: {payload.target_duration_sec} seconds\n"
        f"Target word count: approximately {int(payload.target_duration_sec * WORDS_PER_SECOND)} words"
    )

    with timed(log, "openai.chat.completions", model=settings.openai_model_quality):
        response = chat_with_fallback(
            primary_model=settings.openai_model_quality,
            fallback_model=settings.openai_model_fast,
            temperature=0.8,
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

    content = response.choices[0].message.content or "{}"
    data = json.loads(content)
    data = _recompute_metrics(data)
    out = ScriptOutput.model_validate(data).model_dump()
    log.info(
        "script words=%d est_duration_sec=%d hook=%r",
        out["word_count"],
        out["duration_estimate_sec"],
        out["hook"][:60],
    )
    return out
