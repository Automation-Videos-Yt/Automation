from pydantic import BaseModel, Field


class TimestampInput(BaseModel):
    audio_path: str
    script_text: str
    target_scene_sec: float = Field(default=7.5, ge=3.0, le=20.0)
    language_code: str | None = Field(default=None, min_length=2, max_length=10)


class WordSpan(BaseModel):
    word: str
    start: float
    end: float


class SceneSpan(BaseModel):
    index: int
    start: float
    end: float
    text: str


class TimestampOutput(BaseModel):
    total_duration_sec: float
    words: list[WordSpan]
    scenes: list[SceneSpan]
