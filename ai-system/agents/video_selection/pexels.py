from typing import Any
import httpx
from lib.log import get_logger

log = get_logger("pexels")

_BASE = "https://api.pexels.com/videos/search"


class PexelsError(Exception):
    pass


def search_clip(
    api_key: str,
    query: str,
    min_duration: float,
    orientation: str = "landscape",
    per_page: int = 15,
    timeout: float = 15.0,
) -> dict[str, Any] | None:
    """Return the first Pexels video whose duration >= min_duration, else the longest result."""
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
        return None

    def best_file(v: dict) -> dict | None:
        # Prefer HD files around 720p for faster rendering; fall back to highest-res.
        files = v.get("video_files") or []
        hd720 = [f for f in files if f.get("height") == 720 and f.get("quality") == "hd"]
        if hd720:
            return hd720[0]
        hd = [f for f in files if f.get("quality") == "hd"]
        if hd:
            return min(hd, key=lambda f: abs((f.get("height") or 0) - 720))
        return files[0] if files else None

    videos.sort(key=lambda v: float(v.get("duration") or 0), reverse=True)
    for v in videos:
        dur = float(v.get("duration") or 0)
        if dur >= min_duration:
            vf = best_file(v)
            if vf and vf.get("link"):
                return {
                    "provider_id": str(v.get("id")),
                    "clip_url": vf["link"],
                    "clip_duration_sec": dur,
                    "width": vf.get("width"),
                    "height": vf.get("height"),
                }

    # Fallback to the longest available clip.
    top = videos[0]
    vf = best_file(top)
    if vf and vf.get("link"):
        log.warning(
            "pexels clip shorter than requested duration=%.2f min=%.2f query=%r",
            float(top.get("duration") or 0),
            min_duration,
            query,
        )
        return {
            "provider_id": str(top.get("id")),
            "clip_url": vf["link"],
            "clip_duration_sec": float(top.get("duration") or 0),
            "width": vf.get("width"),
            "height": vf.get("height"),
        }

    return None
