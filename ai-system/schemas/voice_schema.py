from typing import Literal
from pydantic import BaseModel, Field


class VoiceInput(BaseModel):
    text: str = Field(..., min_length=1)
    output_path: str
    language_code: str = Field(default="en", min_length=2, max_length=10)
    voice_id: str | None = None
    # Voice tiers (cost per 1k chars, approx):
    #   elite    → ElevenLabs turbo   (~$0.18)  — reserved for manual opt-in
    #   premium  → OpenAI tts-1-hd    (~$0.033) — default for strong runs
    #   economy  → OpenAI tts-1       (~$0.015) — default for mid/weak runs
    tier: Literal["elite", "premium", "economy"] = "premium"


class VoiceOutput(BaseModel):
    audio_path: str
    duration_sec: float
    voice_id: str
    provider: str | None = None
