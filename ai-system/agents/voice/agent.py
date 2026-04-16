import os
from elevenlabs.client import ElevenLabs
from mutagen.mp3 import MP3
from config import settings
from schemas import VoiceInput, VoiceOutput
from lib.log import get_logger, timed
from lib.openai_client import get_openai_client

log = get_logger("agent.voice")
_el: ElevenLabs | None = None

# Voice tiers:
#   elite    → ElevenLabs turbo (best quality, ~$0.18/1k chars)
#   premium  → OpenAI tts-1-hd  (HD TTS, ~$0.033/1k chars — ~6x cheaper than elite)
#   economy  → OpenAI tts-1     (standard TTS, ~$0.015/1k chars — ~12x cheaper than elite)
#
# Routing is driven by the `tier` input (see pipeline-runner voiceTierFromScore).
# Any ElevenLabs failure on "elite" falls back to OpenAI TTS so TTS never hard-stops.
OPENAI_TTS_MODEL_PREMIUM = "tts-1-hd"
OPENAI_TTS_MODEL_ECONOMY = "tts-1"
OPENAI_TTS_VOICE_DEFAULT = "alloy"


def _get_el() -> ElevenLabs:
    global _el
    if _el is None:
        _el = ElevenLabs(api_key=settings.elevenlabs_api_key)
    return _el


def _elevenlabs_tts(text: str, voice_id: str, output_path: str) -> int:
    client = _get_el()
    audio_iter = client.text_to_speech.convert(
        voice_id=voice_id,
        model_id="eleven_turbo_v2_5",
        output_format="mp3_44100_128",
        text=text,
    )
    total = 0
    with open(output_path, "wb") as f:
        for chunk in audio_iter:
            if chunk:
                f.write(chunk)
                total += len(chunk)
    return total


def _openai_tts(model: str, text: str, voice: str, output_path: str) -> int:
    client = get_openai_client()
    with client.audio.speech.with_streaming_response.create(
        model=model,
        voice=voice,
        input=text,
        response_format="mp3",
    ) as response:
        response.stream_to_file(output_path)
    return os.path.getsize(output_path)


def run(raw_input: dict) -> dict:
    payload = VoiceInput.model_validate(raw_input)
    voice_id = payload.voice_id or settings.elevenlabs_voice_id
    tier = payload.tier
    chars = len(payload.text)
    log.info(
        "tier=%s chars=%d lang=%s voice_id=%s out=%s",
        tier,
        chars,
        payload.language_code,
        voice_id,
        payload.output_path,
    )

    os.makedirs(os.path.dirname(payload.output_path), exist_ok=True)

    provider_used: str
    bytes_written = 0

    if tier == "elite":
        try:
            with timed(log, "elevenlabs.tts", chars=chars, voice_id=voice_id):
                bytes_written = _elevenlabs_tts(
                    payload.text, voice_id, payload.output_path
                )
            provider_used = "elevenlabs"
        except Exception as e:
            log.warning("elevenlabs failed (%s) — falling back to OpenAI tts-1-hd", e)
            with timed(log, "openai.tts.fallback", chars=chars, model=OPENAI_TTS_MODEL_PREMIUM):
                bytes_written = _openai_tts(
                    OPENAI_TTS_MODEL_PREMIUM,
                    payload.text,
                    OPENAI_TTS_VOICE_DEFAULT,
                    payload.output_path,
                )
            provider_used = "openai-tts-1-hd"
            voice_id = OPENAI_TTS_VOICE_DEFAULT

    elif tier == "premium":
        with timed(log, "openai.tts", chars=chars, model=OPENAI_TTS_MODEL_PREMIUM):
            bytes_written = _openai_tts(
                OPENAI_TTS_MODEL_PREMIUM,
                payload.text,
                OPENAI_TTS_VOICE_DEFAULT,
                payload.output_path,
            )
        provider_used = "openai-tts-1-hd"
        voice_id = OPENAI_TTS_VOICE_DEFAULT

    else:  # economy
        with timed(log, "openai.tts", chars=chars, model=OPENAI_TTS_MODEL_ECONOMY):
            bytes_written = _openai_tts(
                OPENAI_TTS_MODEL_ECONOMY,
                payload.text,
                OPENAI_TTS_VOICE_DEFAULT,
                payload.output_path,
            )
        provider_used = "openai-tts-1"
        voice_id = OPENAI_TTS_VOICE_DEFAULT

    duration = float(MP3(payload.output_path).info.length)
    log.info(
        "audio written provider=%s bytes=%d duration_sec=%.2f",
        provider_used,
        bytes_written,
        duration,
    )

    return VoiceOutput(
        audio_path=payload.output_path,
        duration_sec=duration,
        voice_id=voice_id,
        provider=provider_used,
    ).model_dump()
