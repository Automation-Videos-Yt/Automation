from pydantic import BaseModel, Field

class ScriptEvalInput(BaseModel):
    topic_title: str
    topic_angle: str
    script_hook: str
    script_body: str
    script_cta: str

class ScriptEvalOutput(BaseModel):
    score: float = Field(..., ge=0, le=100)
    passed: bool
    feedback: list[str] = Field(default_factory=list)
