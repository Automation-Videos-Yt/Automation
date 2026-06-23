import json
from config import settings
from schemas import PredictionInput, PredictionOutput
from lib.prompt_registry import PromptVersion
from lib.log import get_logger, timed
from lib.llm import chat
from lib.model_router import TaskType

log = get_logger("agent.prediction")


SYSTEM_PROMPT = """You predict short-form YouTube performance BEFORE the video is published.
You return four numbers and a short reasoning.

Signals that push scores up:
- concrete numbers in title or hook
- unresolved curiosity gap (open loop)
- clear stakes or transformation promise
- short, punchy phrasing (<=20 words)
- niche-specific language a viewer in the niche would recognize

Signals that push scores down:
- vague, generic phrasing ("tips", "tricks", "things")
- buried lede (hook doesn't pay off within first 3 seconds)
- listicle structure without a twist
- topic that demands expertise the script doesn't show

Past-run calibration (if provided): use actual CTR/AVP of similar-niche runs
as anchors. If past CTRs cluster at 3%, do not predict 10% without strong reason.

Scoring:
- predicted_ctr — expected impression CTR in percent (0-30). Typical shorts land 2-8%.
- predicted_retention — expected average view % (0-100). Typical shorts land 30-70%.
- score — overall 0-10 combining both: (ctr/10 * 5) + (retention/100 * 5).
- reasoning — 2-3 short sentences justifying the numbers.

Be honest. Overestimating helps no one. Return only JSON."""


RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "prediction",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "predicted_ctr": {"type": "number"},
                "predicted_retention": {"type": "number"},
                "score": {"type": "number"},
                "reasoning": {"type": "string"},
            },
            "required": ["predicted_ctr", "predicted_retention", "score", "reasoning"],
        },
    },
}


def _past_block(payload: PredictionInput) -> str:
    if not payload.past_performance:
        return ""
    lines = ["\n\nPast runs in similar niches (real anchor data):"]
    for p in payload.past_performance:
        parts = [f'- topic: "{p.topic_title}"']
        if p.hook_text:
            parts.append(f'hook: "{p.hook_text}"')
        if p.ctr is not None:
            parts.append(f"ctr={p.ctr:.1%}")
        if p.avg_view_pct is not None:
            parts.append(f"avp={p.avg_view_pct:.1f}%")
        lines.append(" | ".join(parts))
    return "\n".join(lines)


def run(raw_input: dict) -> dict:
    payload = PredictionInput.model_validate(raw_input)
    log.info(
        "niche=%s topic=%r hook=%r past=%d",
        payload.niche,
        payload.topic_title,
        payload.script_hook[:60],
        len(payload.past_performance),
    )

    user_msg = (
        f"Niche: {payload.niche}\n"
        f"Topic: {payload.topic_title}\n"
        f"Angle: {payload.topic_angle}\n"
        f"Hook (spoken first 3 seconds): {payload.script_hook}\n"
        f"Script body:\n{payload.script_body}"
        f"{_past_block(payload)}"
    )

    with timed(log, "llm.chat", task="PERFORMANCE_PREDICTION"):
        response = chat(
            task_type=TaskType.PERFORMANCE_PREDICTION,
            prompt_version=PromptVersion.PREDICTION_V1,
            temperature=0.3,  # low — we want stable, calibrated numbers
            response_format=RESPONSE_FORMAT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )

    data = json.loads(response.choices[0].message.content or "{}")
    out = PredictionOutput.model_validate(data).model_dump()
    log.info(
        "predicted ctr=%.2f%% retention=%.1f%% score=%.1f",
        out["predicted_ctr"],
        out["predicted_retention"],
        out["score"],
    )
    return out
