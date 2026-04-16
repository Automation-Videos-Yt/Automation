import re
from schemas import TimestampInput, TimestampOutput, WordSpan, SceneSpan
from lib.log import get_logger, timed
from lib.openai_client import get_openai_client

log = get_logger("agent.timestamp")


_SENTENCE_END = re.compile(r"[.!?]$")


def _normalize_whisper_language(code: str | None) -> str | None:
    """Map incoming locale (e.g. hi, pt-BR) to Whisper's language hint."""
    if not code:
        return None
    norm = code.strip().lower().replace("_", "-")
    if not norm:
        return None
    primary = norm.split("-", 1)[0]
    if len(primary) == 2 and primary.isalpha():
        return primary
    return None


def _segment_scenes(
    words: list[WordSpan], target_scene_sec: float
) -> list[SceneSpan]:
    """Greedy: grow a scene until it hits target_scene_sec, prefer sentence
    boundaries near the edge. Never split a sentence across scenes if avoidable.
    """
    if not words:
        return []

    scenes: list[SceneSpan] = []
    buf: list[WordSpan] = []
    scene_start = words[0].start
    idx = 0

    def flush():
        nonlocal buf, scene_start, idx
        if not buf:
            return
        end = buf[-1].end
        text = " ".join(w.word for w in buf).strip()
        scenes.append(
            SceneSpan(index=idx, start=scene_start, end=end, text=text)
        )
        idx += 1
        buf = []

    for w in words:
        if not buf:
            scene_start = w.start
        buf.append(w)
        current_len = w.end - scene_start
        if current_len >= target_scene_sec and _SENTENCE_END.search(w.word):
            flush()
        elif current_len >= target_scene_sec * 1.6:
            # Hard cap: flush regardless of sentence boundary.
            flush()

    flush()
    return scenes


def run(raw_input: dict) -> dict:
    payload = TimestampInput.model_validate(raw_input)
    client = get_openai_client()
    whisper_lang = _normalize_whisper_language(payload.language_code)
    log.info(
        "audio=%s target_scene_sec=%.1f lang=%s whisper_lang=%s",
        payload.audio_path,
        payload.target_scene_sec,
        payload.language_code,
        whisper_lang,
    )

    with timed(log, "openai.whisper.transcribe"):
        with open(payload.audio_path, "rb") as f:
            req = {
                "model": "whisper-1",
                "file": f,
                "response_format": "verbose_json",
                "timestamp_granularities": ["word"],
            }
            if whisper_lang:
                req["language"] = whisper_lang

            resp = client.audio.transcriptions.create(
                **req,
            )

    # The SDK returns a Pydantic-ish object; normalize.
    words_raw = getattr(resp, "words", None) or []
    total_duration = float(getattr(resp, "duration", 0.0))

    words: list[WordSpan] = []
    for w in words_raw:
        word = getattr(w, "word", None) or (w.get("word") if isinstance(w, dict) else None)
        start = getattr(w, "start", None) if word is not None else None
        end = getattr(w, "end", None) if word is not None else None
        if isinstance(w, dict):
            word = w.get("word")
            start = w.get("start")
            end = w.get("end")
        if word is None or start is None or end is None:
            continue
        words.append(WordSpan(word=str(word), start=float(start), end=float(end)))

    if not words:
        log.warning("whisper returned no word timestamps; falling back to uniform distribution")
        # Fallback: uniform distribution over script_text
        tokens = [t for t in payload.script_text.split() if t]
        if tokens and total_duration > 0:
            per = total_duration / len(tokens)
            words = [
                WordSpan(word=t, start=i * per, end=(i + 1) * per)
                for i, t in enumerate(tokens)
            ]

    scenes = _segment_scenes(words, payload.target_scene_sec)

    out = TimestampOutput(
        total_duration_sec=total_duration or (words[-1].end if words else 0.0),
        words=words,
        scenes=scenes,
    ).model_dump()
    log.info(
        "aligned words=%d scenes=%d duration=%.2fs",
        len(words),
        len(scenes),
        out["total_duration_sec"],
    )
    return out
