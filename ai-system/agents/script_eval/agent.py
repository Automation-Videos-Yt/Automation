import json
from lib.prompt_registry import PromptVersion
from lib.log import get_logger, timed
from lib.llm import chat
from lib.model_router import TaskType
from schemas import ScriptEvalInput, ScriptEvalOutput

log = get_logger("agent.script_eval")

SYSTEM_PROMPT = """You are an expert YouTube Shorts script evaluator.

Evaluate the provided script based on:
1. Hook strength: Does it create an immediate curiosity gap?
2. Retention: Are there pattern interrupts? Is the pacing fast?
3. Emotional impact: Does it evoke a clear emotion?
4. CTA effectiveness: Is the call to action clear and compelling?

Score the script from 0 to 100.
If the script is highly engaging and ready for production, score >= 80 and set passed=true.
If the script needs work, score < 80, set passed=false, and provide specific, actionable feedback in the `feedback` array (e.g., "Hook weak", "Curiosity gap missing").

Return ONLY the JSON object conforming to the schema."""

RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "script_eval",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "score": {"type": "number"},
                "passed": {"type": "boolean"},
                "feedback": {
                    "type": "array",
                    "items": {"type": "string"}
                }
            },
            "required": ["score", "passed", "feedback"],
        },
    },
}

def run(raw_input: dict) -> dict:
    payload = ScriptEvalInput.model_validate(raw_input)
    
    user_msg = (
        f"Topic Title: {payload.topic_title}\n"
        f"Topic Angle: {payload.topic_angle}\n\n"
        f"Script Hook: {payload.script_hook}\n"
        f"Script Body: {payload.script_body}\n"
        f"Script CTA: {payload.script_cta}\n"
    )

    with timed(log, "llm.chat", task="SCRIPT_EVALUATION"):
        response = chat(
            task_type=TaskType.SCRIPT_EVALUATION,
            prompt_version=PromptVersion.SCRIPT_EVAL_V1,
            temperature=0.3,
            response_format=RESPONSE_FORMAT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )

    data = json.loads(response.choices[0].message.content or "{}")
    out = ScriptEvalOutput.model_validate(data).model_dump()
    
    # Enforce logic: if score < 80, passed must be false
    if out["score"] < 80:
        out["passed"] = False
    
    log.info("script_eval score=%.1f passed=%s feedback_len=%d", out["score"], out["passed"], len(out["feedback"]))
    return out
