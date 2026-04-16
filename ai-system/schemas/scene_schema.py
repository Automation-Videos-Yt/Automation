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


class ClipCandidate(BaseModel):
    rank: int
    query: str
    clip_url: str
    clip_source: str = "pexels"
    clip_duration_sec: float | None = None
    provider_id: str | None = None
    semantic_score: float = Field(..., ge=0, le=1)
    emotion_score: float = Field(..., ge=0, le=1)
    visual_intensity_score: float = Field(..., ge=0, le=1)
    overall_score: float = Field(..., ge=0, le=1)


class SelectedClip(BaseModel):
    index: int
    start: float
    end: float
    text: str
    segment_text: str | None = None
    query: str
    clip_url: str | None
    clip_source: str | None  # e.g. "pexels"
    clip_duration_sec: float | None
    provider_id: str | None = None
    emotion: str = "informative / neutral"
    keywords: list[str] = Field(default_factory=list)
    search_queries: list[str] = Field(default_factory=list)
    visual_intent: str = ""
    top_candidates: list[ClipCandidate] = Field(default_factory=list)


class VideoSelectionOutput(BaseModel):
    scenes: list[SelectedClip]
    segments: list[SelectedClip] = Field(default_factory=list)
