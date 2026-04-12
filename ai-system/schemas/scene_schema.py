from pydantic import BaseModel, Field


class SceneInput(BaseModel):
    index: int
    start: float
    end: float
    text: str


class VideoSelectionInput(BaseModel):
    topic_title: str
    topic_angle: str
    scenes: list[SceneInput]
    orientation: str = Field(default="landscape")  # landscape | portrait


class SelectedClip(BaseModel):
    index: int
    start: float
    end: float
    text: str
    query: str
    clip_url: str | None
    clip_source: str | None  # e.g. "pexels"
    clip_duration_sec: float | None
    provider_id: str | None = None


class VideoSelectionOutput(BaseModel):
    scenes: list[SelectedClip]
