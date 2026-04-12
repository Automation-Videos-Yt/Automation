from pydantic import BaseModel, Field


class ScriptInput(BaseModel):
    topic_title: str
    topic_angle: str
    target_duration_sec: int = Field(default=75, ge=30, le=180)


class ScriptOutput(BaseModel):
    hook: str
    body: str
    cta: str
    word_count: int
    duration_estimate_sec: int
