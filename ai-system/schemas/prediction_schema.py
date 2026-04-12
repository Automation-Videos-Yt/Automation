from pydantic import BaseModel, Field


class PastPerformanceContext(BaseModel):
    topic_title: str
    hook_text: str | None = None
    ctr: float | None = None
    avg_view_pct: float | None = None


class PredictionInput(BaseModel):
    niche: str
    topic_title: str
    topic_angle: str
    script_hook: str
    script_body: str
    past_performance: list[PastPerformanceContext] = Field(default_factory=list)


class PredictionOutput(BaseModel):
    predicted_ctr: float = Field(..., ge=0, le=30)  # in percent
    predicted_retention: float = Field(..., ge=0, le=100)  # avg view %
    score: float = Field(..., ge=0, le=10)
    reasoning: str
