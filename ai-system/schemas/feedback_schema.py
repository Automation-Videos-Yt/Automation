from pydantic import BaseModel, Field


class FeedbackMetrics(BaseModel):
    views: int | None = None
    impressions: int | None = None
    ctr: float | None = None
    avg_view_duration_sec: float | None = None
    avg_view_percentage: float | None = None
    watch_time_minutes: float | None = None
    likes: int | None = None
    comments: int | None = None


class FeedbackInput(BaseModel):
    niche: str
    topic_title: str
    topic_angle: str
    script_hook: str
    hook_variants: list[dict] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    metrics: FeedbackMetrics


class FeedbackOutput(BaseModel):
    what_worked: str
    what_didnt: str
    suggestions: str
    performance_tag: str  # "strong" | "mid" | "weak"
