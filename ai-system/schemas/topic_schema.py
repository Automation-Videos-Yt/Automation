from pydantic import BaseModel, Field


class PastTopicContext(BaseModel):
    topic_title: str
    topic_angle: str
    performance_tag: str | None = None
    views: int | None = None
    ctr: float | None = None
    avg_view_pct: float | None = None


class TopicInput(BaseModel):
    niche: str = Field(..., min_length=3, max_length=120)
    language_code: str = Field(default="en", min_length=2, max_length=10)
    past_topics: list[PastTopicContext] = Field(default_factory=list)
    # Titles the agent must NOT produce (used for duplicate-topic retry).
    exclude_titles: list[str] = Field(default_factory=list)


class TopicOutput(BaseModel):
    title: str
    angle: str
    rationale: str
    trend_score: float = Field(default=0.8, ge=0, le=1)
