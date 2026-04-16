import json
from config import settings
from schemas import VideoSelectionInput, VideoSelectionOutput, SelectedClip
from lib.log import get_logger, timed
from lib.openai_client import get_openai_client
from .pexels import PexelsError, search_clip

log = get_logger("agent.video_selection")


QUERY_SYSTEM = """You generate stock-footage search queries.
For each scene, produce a SHORT (2-4 word) concrete visual query that a stock
library would match. Prefer nouns + actions. Avoid abstract concepts.
Examples:
  scene "Most servers run with default JVM settings" -> "computer server racks"
  scene "You waste your morning scrolling Twitter"    -> "person scrolling phone"
Return only the JSON the schema requires."""


def _query_schema(n: int) -> dict:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "scene_queries",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "queries": {
                        "type": "array",
                        "minItems": n,
                        "maxItems": n,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "index": {"type": "integer"},
                                "query": {"type": "string"},
                            },
                            "required": ["index", "query"],
                        },
                    }
                },
                "required": ["queries"],
            },
        },
    }


def _generate_queries(
    payload: VideoSelectionInput,
) -> dict[int, str]:
    client = get_openai_client()
    scene_lines = "\n".join(
        f"Scene {s.index} ({s.end - s.start:.1f}s): {s.text}" for s in payload.scenes
    )
    user_msg = (
        f"Topic: {payload.topic_title}\nAngle: {payload.topic_angle}\n\n"
        f"Produce one visual query per scene (same indices).\n\n{scene_lines}"
    )

    with timed(log, "openai.query_gen", model=settings.openai_model_fast):
        resp = client.chat.completions.create(
            model=settings.openai_model_fast,
            temperature=0.6,
            response_format=_query_schema(len(payload.scenes)),
            messages=[
                {"role": "system", "content": QUERY_SYSTEM},
                {"role": "user", "content": user_msg},
            ],
        )
    data = json.loads(resp.choices[0].message.content or "{}")
    mapped: dict[int, str] = {}
    for q in data.get("queries", []):
        mapped[int(q["index"])] = str(q["query"])
    return mapped


def run(raw_input: dict) -> dict:
    payload = VideoSelectionInput.model_validate(raw_input)
    log.info(
        "scenes=%d orientation=%s", len(payload.scenes), payload.orientation
    )

    queries = _generate_queries(payload)

    selected: list[SelectedClip] = []
    pexels_hits = 0
    pexels_misses = 0

    for scene in payload.scenes:
        q = queries.get(scene.index) or _fallback_query(scene.text)
        scene_dur = scene.end - scene.start

        try:
            hit = search_clip(
                api_key=settings.pexels_api_key,
                query=q,
                min_duration=scene_dur,
                orientation=payload.orientation,
            )
        except PexelsError as e:
            log.error("pexels error for scene=%d query=%r: %s", scene.index, q, e)
            hit = None

        if hit:
            pexels_hits += 1
            log.info(
                "scene=%d query=%r -> %s (dur=%.2fs)",
                scene.index,
                q,
                hit["provider_id"],
                hit["clip_duration_sec"],
            )
            selected.append(
                SelectedClip(
                    index=scene.index,
                    start=scene.start,
                    end=scene.end,
                    text=scene.text,
                    query=q,
                    clip_url=hit["clip_url"],
                    clip_source="pexels",
                    clip_duration_sec=hit["clip_duration_sec"],
                    provider_id=hit["provider_id"],
                )
            )
        else:
            pexels_misses += 1
            log.warning("no clip for scene=%d query=%r", scene.index, q)
            selected.append(
                SelectedClip(
                    index=scene.index,
                    start=scene.start,
                    end=scene.end,
                    text=scene.text,
                    query=q,
                    clip_url=None,
                    clip_source=None,
                    clip_duration_sec=None,
                    provider_id=None,
                )
            )

    log.info("pexels hits=%d misses=%d", pexels_hits, pexels_misses)
    return VideoSelectionOutput(scenes=selected).model_dump()


def _fallback_query(text: str) -> str:
    # Cheap keyword extraction — first 3 non-stopwords.
    stop = {
        "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to",
        "for", "is", "are", "was", "were", "be", "been", "it", "its", "this",
        "that", "with", "as", "by", "from", "you", "your", "i", "we", "our",
        "they", "them", "their", "he", "she", "his", "her", "them",
    }
    words = [w.strip(".,!?:;\"'()").lower() for w in text.split()]
    keep = [w for w in words if w and w not in stop][:3]
    return " ".join(keep) or "abstract background"
