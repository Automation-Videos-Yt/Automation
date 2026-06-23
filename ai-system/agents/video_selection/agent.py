import json
import re
from typing import Any
from config import settings
from schemas import VideoSelectionInput, VideoSelectionOutput, SelectedClip, ClipCandidate
from lib.log import get_logger, timed
from lib.openai_client import get_openai_client
from .pexels import PexelsError, search_clips

log = get_logger("agent.video_selection")


EMOTIONS = [
    "shock / surprise",
    "curiosity",
    "fear / danger",
    "excitement",
    "suspense",
    "informative / neutral",
]

_WORD_RE = re.compile(r"[a-z0-9]+")
_STOP = {
    "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to",
    "for", "is", "are", "was", "were", "be", "been", "it", "its", "this",
    "that", "with", "as", "by", "from", "you", "your", "i", "we", "our",
    "they", "them", "their", "he", "she", "his", "her", "into", "out",
    "up", "down", "about", "over", "under", "after", "before", "than",
}

_MOTION_CUES = {
    "running", "jump", "jumping", "driving", "moving", "motion", "speed",
    "explosion", "blast", "race", "chase", "falling", "crash", "storm",
    "fire", "waves", "crowd", "action", "dynamic", "fast",
}
_REACTION_CUES = {
    "reaction", "shocked", "surprised", "panic", "worried", "fear", "scream",
    "face", "closeup", "people", "person", "man", "woman", "team", "engineer",
    "scientist", "audience", "crowd", "laugh", "cry", "celebrate",
}
_DRAMA_CUES = {
    "cinematic", "dramatic", "contrast", "dark", "glow", "neon", "intense",
    "tension", "suspense", "danger", "emergency", "disaster", "smoke",
    "warning", "mystery", "silhouette", "countdown",
}
_EMOTION_CUES = {
    "shock / surprise": {"explosion", "shock", "shocked", "panic", "breaking", "sudden", "crash", "reaction"},
    "curiosity": {"mystery", "discover", "investigate", "question", "search", "reveal", "hidden"},
    "fear / danger": {"danger", "warning", "fire", "storm", "evacuate", "risk", "accident", "panic"},
    "excitement": {"celebration", "victory", "race", "speed", "crowd", "energy", "action", "cheer"},
    "suspense": {"dark", "tension", "countdown", "shadow", "mystery", "waiting", "silhouette"},
    "informative / neutral": {"explainer", "office", "presentation", "analysis", "documentary", "report"},
}


SCENE_INTELLIGENCE_SYSTEM = """You are an advanced video scene intelligence agent for short-form content.

For EACH scene segment:
1) extract semantic meaning (subject, action, context),
2) classify emotion from this set exactly:
   shock / surprise, curiosity, fear / danger, excitement, suspense, informative / neutral,
3) generate visual intent and 3-5 high-quality stock search queries.

Rules:
- Use action + subject + emotion terms.
- Avoid generic one-word queries.
- Prefer dynamic visuals with motion, reactions, contrast.
- Ensure variety across segments (avoid repeating near-identical query phrasing).
- First 3 seconds must be high-impact and visually dramatic.

Return only JSON matching the requested schema."""


def _scene_plan_schema(n: int) -> dict:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "scene_intelligence",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "segments": {
                        "type": "array",
                        "minItems": n,
                        "maxItems": n,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "index": {"type": "integer"},
                                "segment_text": {"type": "string"},
                                "subject": {"type": "string"},
                                "action": {"type": "string"},
                                "context": {"type": "string"},
                                "emotion": {
                                    "type": "string",
                                    "enum": EMOTIONS,
                                },
                                "keywords": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 8,
                                    "items": {"type": "string"},
                                },
                                "search_queries": {
                                    "type": "array",
                                    "minItems": 3,
                                    "maxItems": 5,
                                    "items": {"type": "string"},
                                },
                                "visual_intent": {"type": "string"},
                            },
                            "required": [
                                "index",
                                "segment_text",
                                "subject",
                                "action",
                                "context",
                                "emotion",
                                "keywords",
                                "search_queries",
                                "visual_intent",
                            ],
                        },
                    }
                },
                "required": ["segments"],
            },
        },
    }


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def _tokenize(text: str) -> set[str]:
    return {t for t in _WORD_RE.findall(text.lower()) if t and t not in _STOP}


def _normalize_str_list(values: list[Any], max_items: int) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        if not isinstance(v, str):
            continue
        s = " ".join(v.strip().split())
        if not s:
            continue
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(s)
        if len(out) >= max_items:
            break
    return out


def _fallback_query(text: str) -> str:
    words = [w.strip(".,!?:;\"'()").lower() for w in text.split()]
    keep = [w for w in words if w and w not in _STOP][:4]
    return " ".join(keep) or "high impact reaction shot"


def _fallback_queries(text: str) -> list[str]:
    base = _fallback_query(text)
    return [
        base,
        f"{base} cinematic action",
        f"{base} human reaction",
    ]


def _fallback_plan(index: int, text: str) -> dict[str, Any]:
    keywords = list(_tokenize(text))[:5]
    queries = _normalize_str_list(_fallback_queries(text), max_items=5)
    return {
        "index": index,
        "segment_text": text,
        "emotion": "informative / neutral",
        "keywords": keywords,
        "search_queries": queries,
        "visual_intent": "contextual cinematic b-roll matching narration",
    }


def _diversify_queries(plans: dict[int, dict[str, Any]]) -> None:
    seen: set[str] = set()
    for idx in sorted(plans):
        plan = plans[idx]
        diversified: list[str] = []
        for q in plan["search_queries"]:
            qn = q.lower()
            if qn in seen:
                kw = (plan["keywords"][0] if plan["keywords"] else "dramatic").strip()
                q = f"{q} {kw}".strip()
                qn = q.lower()
            diversified.append(q)
            seen.add(qn)
        plan["search_queries"] = _normalize_str_list(diversified, max_items=5)


def _generate_scene_plans(payload: VideoSelectionInput) -> dict[int, dict[str, Any]]:
    client = get_openai_client()
    scene_lines = "\n".join(
        f"Scene {s.index} [{s.start:.1f}s-{s.end:.1f}s]: {s.text}" for s in payload.scenes
    )
    user_msg = (
        f"Topic: {payload.topic_title}\n"
        f"Angle: {payload.topic_angle}\n"
        f"Output orientation: {payload.orientation}\n\n"
        f"First 3 seconds must be high-impact with dramatic visuals and motion.\n"
        f"Use varied visual directions across scenes to avoid repetition.\n\n"
        f"Segments:\n{scene_lines}"
    )

    from lib.llm import chat
    from lib.model_router import TaskType

    with timed(log, "llm.scene_intelligence", task="VIDEO_SELECTION"):
        try:
            resp = chat(
                task_type=TaskType.VIDEO_SELECTION,
                temperature=0.8,
                response_format=_scene_plan_schema(len(payload.scenes)),
                messages=[
                    {"role": "system", "content": SCENE_INTELLIGENCE_SYSTEM},
                    {"role": "user", "content": user_msg},
                ],
            )
            data = json.loads(resp.choices[0].message.content or "{}")
        except Exception as e:
            log.warning("scene_intelligence generation failed across all providers: %s, using dumb fallback for all scenes", e)
            data = {}
    mapped: dict[int, dict[str, Any]] = {}
    for seg in data.get("segments", []):
        if not isinstance(seg, dict):
            continue
        idx = int(seg.get("index", -1))
        if idx < 0:
            continue
        emotion = str(seg.get("emotion") or "informative / neutral").strip().lower()
        emotion = emotion if emotion in EMOTIONS else "informative / neutral"
        keywords = _normalize_str_list(seg.get("keywords", []), max_items=8)
        queries = _normalize_str_list(seg.get("search_queries", []), max_items=5)
        if len(queries) < 3:
            queries = _normalize_str_list(queries + _fallback_queries(str(seg.get("segment_text", ""))), max_items=5)
        mapped[idx] = {
            "index": idx,
            "segment_text": str(seg.get("segment_text") or "").strip(),
            "emotion": emotion,
            "keywords": keywords,
            "search_queries": queries,
            "visual_intent": str(seg.get("visual_intent") or "").strip(),
        }

    for s in payload.scenes:
        if s.index not in mapped:
            mapped[s.index] = _fallback_plan(s.index, s.text)
        if not mapped[s.index]["segment_text"]:
            mapped[s.index]["segment_text"] = s.text

    _diversify_queries(mapped)
    return mapped


def _semantic_score(scene_tokens: set[str], query_tokens: set[str], keywords: set[str]) -> float:
    reference = scene_tokens | keywords
    if not reference or not query_tokens:
        return 0.0
    hit = len(reference & query_tokens)
    return _clamp(hit / max(1, min(len(reference), len(query_tokens))))


def _emotion_score(emotion: str, query_tokens: set[str]) -> float:
    cues = _EMOTION_CUES.get(emotion, _EMOTION_CUES["informative / neutral"])
    if not query_tokens:
        return 0.0
    hits = len(cues & query_tokens)
    # Small base score so candidates are not zeroed when cues are sparse.
    return _clamp(0.15 + (hits / max(1, len(cues))) * 1.6)


def _visual_intensity_score(
    query_tokens: set[str],
    clip_duration_sec: float,
    scene_duration_sec: float,
    is_opening: bool,
) -> float:
    motion_hits = len(query_tokens & _MOTION_CUES)
    reaction_hits = len(query_tokens & _REACTION_CUES)
    drama_hits = len(query_tokens & _DRAMA_CUES)
    duration_fit = _clamp(clip_duration_sec / max(0.1, scene_duration_sec))

    score = 0.10
    score += 0.30 * _clamp(motion_hits / 2)
    score += 0.20 * _clamp(reaction_hits / 1)
    score += 0.20 * _clamp(drama_hits / 2)
    score += 0.20 * duration_fit

    if is_opening and (motion_hits + drama_hits) == 0:
        score *= 0.75

    return _clamp(score)


def _query_root(query: str) -> str:
    toks = [t for t in _WORD_RE.findall(query.lower()) if t not in _STOP]
    return " ".join(toks[:3])


def _rank_candidates(
    scene_start: float,
    scene_text: str,
    scene_duration: float,
    emotion: str,
    keywords: list[str],
    raw_candidates: list[dict[str, Any]],
    used_provider_ids: set[str],
    used_query_roots: set[str],
) -> list[dict[str, Any]]:
    scene_tokens = _tokenize(scene_text)
    keyword_tokens = _tokenize(" ".join(keywords))
    opening = scene_start < 3.0

    out: list[dict[str, Any]] = []
    for c in raw_candidates:
        query = str(c.get("query") or "")
        q_tokens = _tokenize(query)
        dur = float(c.get("clip_duration_sec") or 0.0)

        sem = _semantic_score(scene_tokens, q_tokens, keyword_tokens)
        emo = _emotion_score(emotion, q_tokens)
        vis = _visual_intensity_score(q_tokens, dur, scene_duration, opening)

        if opening:
            overall = sem * 0.35 + emo * 0.25 + vis * 0.40
        else:
            overall = sem * 0.45 + emo * 0.30 + vis * 0.25

        provider_id = str(c.get("provider_id") or "")
        if provider_id and provider_id in used_provider_ids:
            overall *= 0.88

        root = _query_root(query)
        if root and root in used_query_roots:
            overall *= 0.92

        out.append(
            {
                **c,
                "semantic_score": _clamp(sem),
                "emotion_score": _clamp(emo),
                "visual_intensity_score": _clamp(vis),
                "overall_score": _clamp(overall),
                "query_root": root,
            }
        )

    out.sort(
        key=lambda c: (
            float(c.get("overall_score") or 0),
            float(c.get("visual_intensity_score") or 0),
            float(c.get("clip_duration_sec") or 0),
        ),
        reverse=True,
    )
    return out[:3]


def _fetch_candidates(
    queries: list[str],
    orientation: str,
) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for q in queries:
        hits = search_clips(
            api_key=settings.pexels_api_key,
            query=q,
            orientation=orientation,
            per_page=12,
        )
        for h in hits[:6]:
            pid = str(h.get("provider_id") or h.get("clip_url"))
            cand = {
                **h,
                "query": q,
                "clip_source": "pexels",
            }
            prev = by_id.get(pid)
            if prev is None or float(cand.get("clip_duration_sec") or 0) > float(prev.get("clip_duration_sec") or 0):
                by_id[pid] = cand
    return list(by_id.values())


def run(raw_input: dict) -> dict:
    payload = VideoSelectionInput.model_validate(raw_input)
    log.info(
        "scenes=%d orientation=%s", len(payload.scenes), payload.orientation
    )

    plans = _generate_scene_plans(payload)

    selected: list[SelectedClip] = []
    pexels_hits = 0
    pexels_misses = 0
    used_provider_ids: set[str] = set()
    used_query_roots: set[str] = set()

    for scene in payload.scenes:
        plan = plans.get(scene.index) or _fallback_plan(scene.index, scene.text)
        queries = plan.get("search_queries") or _fallback_queries(scene.text)
        queries = _normalize_str_list(list(queries), max_items=5)
        if len(queries) < 3:
            queries = _normalize_str_list(queries + _fallback_queries(scene.text), max_items=5)

        q = queries[0] if queries else _fallback_query(scene.text)
        scene_dur = scene.end - scene.start

        try:
            raw_candidates = _fetch_candidates(
                queries=queries,
                orientation=payload.orientation,
            )
        except PexelsError as e:
            log.error("pexels error for scene=%d queries=%r: %s", scene.index, queries, e)
            raw_candidates = []

        ranked = _rank_candidates(
            scene_start=scene.start,
            scene_text=scene.text,
            scene_duration=scene_dur,
            emotion=str(plan.get("emotion") or "informative / neutral"),
            keywords=list(plan.get("keywords") or []),
            raw_candidates=raw_candidates,
            used_provider_ids=used_provider_ids,
            used_query_roots=used_query_roots,
        )

        top_candidates = [
            ClipCandidate(
                rank=i + 1,
                query=str(c.get("query") or ""),
                clip_url=str(c.get("clip_url") or ""),
                clip_source="pexels",
                clip_duration_sec=float(c.get("clip_duration_sec") or 0.0),
                provider_id=str(c.get("provider_id") or "") or None,
                semantic_score=float(c.get("semantic_score") or 0.0),
                emotion_score=float(c.get("emotion_score") or 0.0),
                visual_intensity_score=float(c.get("visual_intensity_score") or 0.0),
                overall_score=float(c.get("overall_score") or 0.0),
            )
            for i, c in enumerate(ranked)
        ]

        if ranked:
            hit = ranked[0]
            pexels_hits += 1
            best_provider = str(hit.get("provider_id") or "")
            if best_provider:
                used_provider_ids.add(best_provider)
            root = _query_root(str(hit.get("query") or ""))
            if root:
                used_query_roots.add(root)

            log.info(
                "scene=%d emotion=%s query=%r -> %s (dur=%.2fs score=%.2f)",
                scene.index,
                plan.get("emotion"),
                hit.get("query"),
                hit["provider_id"],
                hit["clip_duration_sec"],
                float(hit.get("overall_score") or 0.0),
            )
            selected.append(
                SelectedClip(
                    index=scene.index,
                    start=scene.start,
                    end=scene.end,
                    text=scene.text,
                    segment_text=scene.text,
                    query=str(hit.get("query") or q),
                    clip_url=hit["clip_url"],
                    clip_source="pexels",
                    clip_duration_sec=float(hit.get("clip_duration_sec") or 0.0),
                    provider_id=str(hit.get("provider_id") or "") or None,
                    emotion=str(plan.get("emotion") or "informative / neutral"),
                    keywords=_normalize_str_list(list(plan.get("keywords") or []), max_items=8),
                    search_queries=queries,
                    visual_intent=str(plan.get("visual_intent") or ""),
                    top_candidates=top_candidates,
                )
            )
        else:
            pexels_misses += 1
            log.warning("no clip for scene=%d queries=%r", scene.index, queries)
            selected.append(
                SelectedClip(
                    index=scene.index,
                    start=scene.start,
                    end=scene.end,
                    text=scene.text,
                    segment_text=scene.text,
                    query=q,
                    clip_url=None,
                    clip_source=None,
                    clip_duration_sec=None,
                    provider_id=None,
                    emotion=str(plan.get("emotion") or "informative / neutral"),
                    keywords=_normalize_str_list(list(plan.get("keywords") or []), max_items=8),
                    search_queries=queries,
                    visual_intent=str(plan.get("visual_intent") or ""),
                    top_candidates=top_candidates,
                )
            )

    log.info("pexels hits=%d misses=%d", pexels_hits, pexels_misses)
    return VideoSelectionOutput(scenes=selected, segments=selected).model_dump()
