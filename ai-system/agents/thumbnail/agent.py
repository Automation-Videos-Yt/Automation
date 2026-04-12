import base64
import json
import os
from openai import OpenAI
from config import settings
from schemas import ThumbnailInput, ThumbnailOutput
from lib.log import get_logger, timed

log = get_logger("agent.thumbnail")
_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=settings.openai_api_key)
    return _client


PROMPT_SYSTEM = """You design YouTube thumbnails.
Given a topic and hook, output a single dense visual prompt for an image model.

Rules for the prompt:
- Describe ONE strong focal subject (not a busy collage).
- High contrast, saturated colors, dramatic lighting.
- Cinematic, photographic-realism; NO text rendered in the image (titles are added separately).
- No text, no letters, no logos, no watermarks. Say that explicitly.
- Aspect 16:9.

Return JSON with a single key 'prompt'."""


PROMPT_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "thumb_prompt",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"prompt": {"type": "string"}},
            "required": ["prompt"],
        },
    },
}


def _craft_prompt(payload: ThumbnailInput) -> str:
    client = _get_client()
    user = (
        f"Topic title: {payload.topic_title}\n"
        f"Angle: {payload.topic_angle}\n"
        f"Hook: {payload.script_hook}"
    )
    with timed(log, "openai.prompt_craft", model=settings.openai_model_fast):
        resp = client.chat.completions.create(
            model=settings.openai_model_fast,
            temperature=0.9,
            response_format=PROMPT_RESPONSE_FORMAT,
            messages=[
                {"role": "system", "content": PROMPT_SYSTEM},
                {"role": "user", "content": user},
            ],
        )
    data = json.loads(resp.choices[0].message.content or "{}")
    prompt = str(data.get("prompt", "")).strip()
    if not prompt:
        raise RuntimeError("thumbnail prompt crafting returned empty string")
    return prompt


def run(raw_input: dict) -> dict:
    payload = ThumbnailInput.model_validate(raw_input)
    client = _get_client()
    log.info("topic=%r size=%s out=%s", payload.topic_title, payload.size, payload.output_path)

    prompt = _craft_prompt(payload)
    log.info("prompt=%r", prompt[:140])

    os.makedirs(os.path.dirname(payload.output_path), exist_ok=True)

    with timed(
        log,
        "openai.images.generate",
        model="gpt-image-1",
        size=payload.size,
        quality=payload.quality,
    ):
        result = client.images.generate(
            model="gpt-image-1",
            prompt=prompt,
            size=payload.size,
            quality=payload.quality,
            n=1,
        )

    img = result.data[0]
    b64 = getattr(img, "b64_json", None)
    if not b64:
        raise RuntimeError("image api returned no b64_json payload")
    binary = base64.b64decode(b64)
    with open(payload.output_path, "wb") as f:
        f.write(binary)

    width, height = 0, 0
    if "x" in payload.size:
        try:
            w_s, h_s = payload.size.split("x", 1)
            width, height = int(w_s), int(h_s)
        except ValueError:
            pass

    log.info(
        "thumbnail written bytes=%d quality=%s path=%s",
        len(binary),
        payload.quality,
        payload.output_path,
    )
    return ThumbnailOutput(
        image_path=payload.output_path,
        prompt=prompt,
        width=width,
        height=height,
        quality=payload.quality,
    ).model_dump()
