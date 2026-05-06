from pydantic import BaseModel, Field


class PastTopicContext(BaseModel):
    topic_title: str
    topic_angle: str
    performance_tag: str | None = None
    views: int | None = None
    ctr: float | None = None
    avg_view_pct: float | None = None


class ScriptInput(BaseModel):
    topic_title: str
    topic_angle: str
    # 10-180s: 10-25s covers Shorts/Reels snappy edits; 180s is the Shorts cap.
    target_duration_sec: int = Field(default=75, ge=10, le=180)
    language_code: str = Field(default="en", min_length=2, max_length=10)
    past_topics: list[PastTopicContext] = Field(default_factory=list)


class ScriptOutput(BaseModel):
    hook: str
    body: str
    cta: str
    word_count: int
    duration_estimate_sec: int
