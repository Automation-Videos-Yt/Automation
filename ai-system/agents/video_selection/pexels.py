from typing import Any
import httpx
from lib.log import get_logger

log = get_logger("pexels")

_BASE = "https://api.pexels.com/videos/search"


class PexelsError(Exception):
    pass


def search_clips(
    api_key: str,
    query: str,
    orientation: str = "landscape",
    per_page: int = 15,
    timeout: float = 15.0,
) -> list[dict[str, Any]]:
    """Return multiple candidate clips sorted by duration (desc)."""
    if not api_key:
        raise PexelsError("PEXELS_API_KEY is not configured")

    params = {
        "query": query,
        "per_page": per_page,
        "orientation": orientation,
    }
    headers = {"Authorization": api_key}

    with httpx.Client(timeout=timeout) as client:
        r = client.get(_BASE, params=params, headers=headers)
        if r.status_code != 200:
            raise PexelsError(f"pexels {r.status_code}: {r.text[:200]}")
        data = r.json()

    videos = data.get("videos") or []
    if not videos:
        log.info("pexels no-results query=%r", query)
        return []

    def best_file(v: dict) -> dict | None:
        files = v.get("video_files") or []
        hd720 = [
            f
            for f in files
            if f.get("height") == 720 and f.get("quality") == "hd"
        ]
        if hd720:
            return hd720[0]
        hd = [f for f in files if f.get("quality") == "hd"]
        if hd:
            return min(hd, key=lambda f: abs((f.get("height") or 0) - 720))
        return files[0] if files else None

    out: list[dict[str, Any]] = []
    for v in videos:
        vf = best_file(v)
        if not vf or not vf.get("link"):
            continue
        out.append(
            {
                "provider_id": str(v.get("id")),
                "clip_url": vf["link"],
                "clip_duration_sec": float(v.get("duration") or 0),
                "width": vf.get("width"),
                "height": vf.get("height"),
            }
        )

    out.sort(key=lambda c: float(c.get("clip_duration_sec") or 0), reverse=True)
    return out


def search_clip(
    api_key: str,
    query: str,
    min_duration: float,
    orientation: str = "landscape",
    per_page: int = 15,
    timeout: float = 15.0,
) -> dict[str, Any] | None:
    """Return the first Pexels video whose duration >= min_duration, else the longest result."""
    clips = search_clips(
        api_key=api_key,
        query=query,
        orientation=orientation,
        per_page=per_page,
        timeout=timeout,
    )
    if not clips:
        return None

    for clip in clips:
        if float(clip.get("clip_duration_sec") or 0) >= min_duration:
            return clip

    top = clips[0]
    log.warning(
        "pexels clip shorter than requested duration=%.2f min=%.2f query=%r",
        float(top.get("clip_duration_sec") or 0),
        min_duration,
        query,
    )
    return top
