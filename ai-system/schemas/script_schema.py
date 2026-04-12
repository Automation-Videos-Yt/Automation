from pydantic import BaseModel, Field


class ScriptInput(BaseModel):
    topic_title: str
    topic_angle: str
    # 10-180s: 10-25s covers Shorts/Reels snappy edits; 180s is the Shorts cap.
    target_duration_sec: int = Field(default=75, ge=10, le=180)


class ScriptOutput(BaseModel):
    hook: str
    body: str
    cta: str
    word_count: int
    duration_estimate_sec: int
