import json
from config import settings
from schemas import VideoMetaInput, VideoMetaOutput
from lib.log import get_logger, timed
from lib.openai_client import get_openai_client
from .autocomplete import fetch_suggestions

log = get_logger("agent.video_meta")


SYSTEM_PROMPT = """You write SEO-optimized YouTube metadata for short-form videos.
- Title: <=80 chars, click-worthy but truthful, must include at least one real search phrase from the supplied autocomplete list when it fits naturally.
- Description: 2-4 short paragraphs, first line restates the hook, weave in 3-5 of the real search phrases naturally (no keyword stuffing).
- Tags: 8-15 specific phrases (no hashtags, lowercase, no duplicates). Prefer real autocomplete phrases over invented ones.
- Write title, description, and tags in the requested target language code.
Return only the JSON object the schema requests."""


RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "video_meta",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title", "description", "tags"],
        },
    },
}


def _gather_keyword_seeds(payload: VideoMetaInput) -> list[str]:
    seeds: list[str] = []
    # Seed with the topic title and the first sentence of the script body.
    first_sentence = payload.script_body.split(".")[0].strip()
    seed_queries = {payload.title, first_sentence}
    for q in seed_queries:
        if q:
            seeds.extend(fetch_suggestions(q, max_items=8))

    # Dedupe preserving order.
    seen: set[str] = set()
    unique: list[str] = []
    for s in seeds:
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        unique.append(s)
    return unique[:20]


def run(raw_input: dict) -> dict:
    payload = VideoMetaInput.model_validate(raw_input)
    client = get_openai_client()
    log.info("working_title=%r script_len=%d", payload.title, len(payload.script_body))

    autocomplete = _gather_keyword_seeds(payload)
    log.info("autocomplete_count=%d sample=%s", len(autocomplete), autocomplete[:5])

    autocomplete_block = (
        "\n".join(f"- {s}" for s in autocomplete)
        if autocomplete
        else "(no autocomplete data available — use best judgment)"
    )

    user_msg = (
        f"Working title: {payload.title}\n"
        f"Angle: {payload.angle}\n"
        f"Target language code: {payload.language_code}\n"
        f"Script body:\n{payload.script_body}\n\n"
        f"Real YouTube autocomplete phrases (high search intent):\n{autocomplete_block}"
    )

    from lib.llm import chat
    from lib.model_router import TaskType

    with timed(log, "llm.video_meta", task="VIDEO_META"):
        try:
            resp = chat(
                task_type=TaskType.VIDEO_META,
                temperature=0.7,
                response_format=RESPONSE_FORMAT,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_msg},
                ],
            )
            content = resp.choices[0].message.content or "{}"
            data = json.loads(content)
        except Exception as e:
            log.warning("video_meta generation failed across all providers: %s. Using dumb fallback.", e)
            data = {
                "title": payload.title,
                "description": f"{payload.title}\n\n{payload.script_body[:200]}...\n\n#shorts",
                "tags": [t for t in autocomplete[:10]] if autocomplete else [payload.title.split()[0].lower()]
            }

    out = VideoMetaOutput.model_validate(data).model_dump()
    log.info(
        "seo title=%r tags=%d desc_len=%d",
        out["title"],
        len(out["tags"]),
        len(out["description"]),
    )
    return out
