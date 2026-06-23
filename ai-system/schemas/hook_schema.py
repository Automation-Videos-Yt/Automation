from pydantic import BaseModel, Field


class PastHookContext(BaseModel):
    hook_text: str
    topic_title: str | None = None
    performance_tag: str | None = None
    ctr: float | None = None
    avg_view_pct: float | None = None


class HookInput(BaseModel):
    topic_title: str
    topic_angle: str
    script_body: str
    original_hook: str
    language_code: str = Field(default="en", min_length=2, max_length=10)
    variants: int = Field(default=3, ge=2, le=6)
    past_hooks: list[PastHookContext] = Field(default_factory=list)


class HookVariant(BaseModel):
    text: str
    score: float = Field(..., ge=0, le=10)
    reasoning: str


class HookOutput(BaseModel):
    winning_hook: str
    hook_score: float
    generation_count: int
