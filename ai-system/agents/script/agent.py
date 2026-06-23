import json
from config import settings
from schemas import ScriptInput, ScriptOutput
from lib.prompt_registry import PromptVersion
from lib.log import get_logger, timed
from lib.llm import chat
from lib.model_router import TaskType

log = get_logger("agent.script")

WORDS_PER_SECOND = 2.5


SYSTEM_PROMPT = """You are a senior short-form video scriptwriter for YouTube Shorts.

Goal:
- Maximize 3-second retention AND average view percentage.

Output structure (required):
- hook: 1-2 sentences, <=25 words.
- body: spoken prose (no bullet lists).
- cta: 1 sentence.

Constraints:
- Narration must fit the target duration, assuming ~2.5 words/second.
- Write all narration in the requested target language code.
- No stage directions, no markdown, no emojis, no hashtags.
- Avoid filler intros like “Today we’re going to…” or “In this video…”.

Shorts-specific pacing rules:
- The hook must create an open loop (curiosity gap) within the first 3 seconds.
- Add a pattern interrupt every ~5-7 seconds (e.g., a short punchy line, a surprising fact, a quick question, or a micro-contrast like “Most people do X… but Y…”).
- Keep sentences short and punchy; vary sentence length.
- Use concrete details (numbers, specific examples) instead of generic advice.
- Maintain the original topic meaning; do not invent risky/unsupported claims.

Emotion + stakes (required):
- Pick ONE dominant emotion for this script (choose from: shock, anxiety, hope, relief, frustration, confidence, curiosity).
- Make the viewer *feel* that emotion within the first 1-2 sentences using concrete stakes (what goes wrong / what they miss / what they gain).
- Use 2nd-person language ("you", "your") and conversational delivery.
- Add at least one "pain → payoff" turn in the body (a quick before/after contrast).

Memory-based learning (if past topics with performance tags are provided):
- Lean TOWARD structural patterns that were tagged "strong".
- Lean AWAY from patterns tagged "weak".
- Do NOT copy past titles/angles verbatim.

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

    past_block = ""
    if payload.past_topics:
        lines = ["\nPast topics from this niche (use as signal, don't copy):"]
        for p in payload.past_topics:
            parts = [f'- "{p.topic_title}" — {p.topic_angle}']
            if p.performance_tag:
                parts.append(f"tag={p.performance_tag}")
            if p.views is not None:
                parts.append(f"views={p.views}")
            if p.ctr is not None:
                parts.append(f"ctr={p.ctr:.1f}%")
            if p.avg_view_pct is not None:
                parts.append(f"avp={p.avg_view_pct:.1f}%")
            lines.append(" | ".join(parts))
        past_block = "\n" + "\n".join(lines)

    user_msg = (
        f"Topic title: {payload.topic_title}\n"
        f"Topic angle: {payload.topic_angle}\n"
        f"Target language code: {payload.language_code}\n"
        f"Target duration: {payload.target_duration_sec} seconds\n"
        f"Target word count: approximately {int(payload.target_duration_sec * WORDS_PER_SECOND)} words"
        f"{past_block}"
    )

    with timed(log, "llm.chat", task="SCRIPT_WRITING"):
        response = chat(
            task_type=TaskType.SCRIPT_WRITING,
            prompt_version=PromptVersion.SCRIPT_V4,
            temperature=0.8,
            response_format=RESPONSE_FORMAT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )

    content = response.choices[0].message.content or "{}"
    data = json.loads(content)
    
    # Handle LLMs that return uppercase keys despite the JSON schema
    data = {k.lower(): v for k, v in data.items()}
    
    data = _recompute_metrics(data)
    out = ScriptOutput.model_validate(data).model_dump()
    log.info(
        "script words=%d est_duration_sec=%d hook=%r",
        out["word_count"],
        out["duration_estimate_sec"],
        out["hook"][:60],
    )
    return out
