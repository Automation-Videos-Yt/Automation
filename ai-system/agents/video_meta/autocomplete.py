import json
import httpx
from lib.log import get_logger

log = get_logger("youtube-autocomplete")

# Unofficial but stable endpoint — same data that powers the YouTube search bar.
_URL = "https://suggestqueries.google.com/complete/search"


def fetch_suggestions(seed: str, max_items: int = 10) -> list[str]:
    if not seed or not seed.strip():
        return []
    params = {"client": "youtube", "ds": "yt", "q": seed.strip()}
    try:
        with httpx.Client(timeout=6.0) as client:
            r = client.get(_URL, params=params)
    except Exception as e:
        log.warning("autocomplete fetch failed seed=%r err=%s", seed, e)
        return []

    if r.status_code != 200:
        log.warning("autocomplete non-200 status=%d seed=%r", r.status_code, seed)
        return []

    # Response is a JSONP-like text: `window.google.ac.h(["seed", [[sug, ...], ...], {...}])`
    text = r.text.strip()
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
    except Exception:
        return []

    if not isinstance(parsed, list) or len(parsed) < 2:
        return []
    entries = parsed[1]
    suggestions: list[str] = []
    for entry in entries:
        if isinstance(entry, list) and entry:
            s = entry[0]
            if isinstance(s, str):
                suggestions.append(s)
        elif isinstance(entry, str):
            suggestions.append(entry)

    # Dedupe + trim to max_items.
    seen: set[str] = set()
    result: list[str] = []
    for s in suggestions:
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        result.append(s)
        if len(result) >= max_items:
            break

    log.info("seed=%r -> %d suggestions", seed, len(result))
    return result
