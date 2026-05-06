import json

from config import settings
from schemas import EditorNotesInput, EditorNotesOutput
from lib.log import get_logger, timed
from lib.llm import chat_with_fallback

log = get_logger("agent.editor_notes")


SYSTEM_PROMPT = """You are a senior short-form video editor.

Goal:
- Make the video feel emotional, punchy, and retention-optimized.

You will receive:
- Language code
- Hook + full script
- Optional timed scenes (index/start/end/text)

Write "editor notes" that a human editor can apply immediately.

Rules:
- Keep everything in the requested language code.
- Be specific and emotional, but do NOT invent risky/unsupported facts.
- No copyrighted specifics (no named songs, no movie clips); describe vibes/cues instead.
- On-screen text must be SHORT (<= 6 words per line), high-impact.
- Use pattern interrupts frequently: zoom, hard cut, sound hit, text pop, speed ramp, quick reaction insert, etc.
- Prefer second-person language ("you", "your") when suggesting text overlays.

Output must match the JSON schema exactly."""


RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "editor_notes",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "dominant_emotion": {"type": "string"},
                "pace": {"type": "string"},
                "global_notes": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 3,
                    "maxItems": 10,
                },
                "scene_notes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "index": {"type": "integer"},
                            "emotion_beat": {"type": "string"},
                            "on_screen_text": {
                                "type": "array",
                                "items": {"type": "string"},
                                "minItems": 0,
                                "maxItems": 3,
                            },
                            "b_roll": {
                                "type": "array",
                                "items": {"type": "string"},
                                "minItems": 0,
                                "maxItems": 6,
                            },
                            "sfx_music": {
                                "type": "array",
                                "items": {"type": "string"},
                                "minItems": 0,
                                "maxItems": 5,
                            },
                            "transition": {"type": "string"},
                        },
                        "required": [
                            "index",
                            "emotion_beat",
                            "on_screen_text",
                            "b_roll",
                            "sfx_music",
                            "transition",
                        ],
                    },
                },
                "caption_emphasis": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 0,
                    "maxItems": 12,
                },
            },
            "required": [
                "dominant_emotion",
                "pace",
                "global_notes",
                "scene_notes",
                "caption_emphasis",
            ],
        },
    },
}


def _scenes_block(payload: EditorNotesInput) -> str:
    if not payload.scenes:
        return "(none)"

    lines: list[str] = []
    for s in payload.scenes:
        t = " ".join((s.text or "").split()).strip()
        if s.start is not None and s.end is not None:
            lines.append(f"[{s.index}] {s.start:.2f}-{s.end:.2f}: {t}")
        else:
            lines.append(f"[{s.index}] {t}")

    return "\n".join(lines)


def run(raw_input: dict) -> dict:
    payload = EditorNotesInput.model_validate(raw_input)
    log.info(
        "lang=%s scenes=%d script_chars=%d",
        payload.language_code,
        len(payload.scenes),
        len(payload.script),
    )

    user_msg = (
        f"Target language code: {payload.language_code}\n"
        f"Target duration (sec): {payload.target_duration_sec or '(unknown)'}\n"
        f"Hook (if provided): {payload.hook or '(none)'}\n\n"
        f"Full script:\n{payload.script}\n\n"
        f"Scenes (optional):\n{_scenes_block(payload)}\n"
    )

    with timed(log, "openai.chat.completions", model=settings.openai_model_quality):
        response = chat_with_fallback(
            primary_model=settings.openai_model_quality,
            fallback_model=settings.openai_model_fast,
            temperature=0.7,
            response_format=RESPONSE_FORMAT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )

    data = json.loads(response.choices[0].message.content or "{}")
    out = EditorNotesOutput.model_validate(data).model_dump()
    return out
