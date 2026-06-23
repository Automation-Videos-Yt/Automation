import json
from config import settings
from schemas import RetentionOptimizerInput, RetentionOptimizerOutput
from lib.log import get_logger, timed
from lib.llm import chat
from lib.model_router import TaskType

log = get_logger("agent.retention_optimizer")


SYSTEM_PROMPT = """You are a retention optimization expert.

Goal:
- Maximize audience retention.

Improve the provided script by:
- Removing fluff.
- Adding pattern interrupts every 5-7 seconds.
- Making sentences shorter.
- Increasing curiosity flow.

Pattern Interrupt Types (use a mix; avoid repeating the same type back-to-back):
- Snap question ("But what if…?")
- Micro-contrast ("Most people do X… but Y…")
- Quick stat/number (one concrete metric)
- Myth vs fact ("You think X. Actually Y.")
- Stakes flip ("If you ignore this, you’ll keep…")
- Mini story beat ("I watched someone… then…")
- Rule break / surprising exception ("Unless you’re doing *this*…")
- Fast recap / reset ("Okay—here’s the 10-second version:")
- Tease + later payoff ("In 15 seconds I’ll show you the fix…")
- Simple analogy (one short comparison)

Preserve engagement:
- Preserve (or strengthen) emotional stakes and urgency already present.
- Preserve open loops (questions/curiosity gaps) and resolve them later in the script.

Constraints:
- Maintain original meaning.
- Keep duration similar.

Output format (strict JSON):
{
  "improved_script": "..."
}

Return only the JSON object above.
"""


RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "retention_optimizer",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "improved_script": {"type": "string"},
            },
            "required": ["improved_script"],
        },
    },
}


def _word_count(text: str) -> int:
    return len([w for w in text.split() if w])


def run(raw_input: dict) -> dict:
    payload = RetentionOptimizerInput.model_validate(raw_input)
    source_words = _word_count(payload.script)
    log.info("source_words=%d language=%s", source_words, payload.language_code)

    user_msg = (
        f"Language code: {payload.language_code}\n"
        f"Original script word count: {source_words}\n"
        "Original script:\n"
        f"{payload.script}"
    )

    with timed(log, "llm.chat", model=settings.openai_model_quality):
        response = chat(
            task_type=TaskType.GENERATION,
            temperature=0.7,
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
    out = RetentionOptimizerOutput.model_validate(data).model_dump()

    improved_words = _word_count(out["improved_script"])
    if source_words > 0:
        drift = abs(improved_words - source_words) / source_words
        if drift > 0.25:
            log.warning(
                "duration drift higher than expected source=%d improved=%d drift=%.2f",
                source_words,
                improved_words,
                drift,
            )

    log.info("improved_words=%d", improved_words)
    return out
