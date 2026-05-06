from pydantic import BaseModel, Field, RootModel, field_validator


def _word_count(text: str) -> int:
    return len([w for w in text.split() if w])


class TopPerformingHook(BaseModel):
    hook_text: str
    performance_tag: str | None = None


class ViralHookInput(BaseModel):
    topic: str = Field(..., min_length=2)
    previous_hook: str = ""
    language_code: str = Field(default="en", min_length=2, max_length=10)
    top_performing_hooks_from_memory: list[str | TopPerformingHook] = Field(
        default_factory=list
    )


class ViralHookOutput(RootModel[list[str]]):
    root: list[str]

    @field_validator("root")
    @classmethod
    def validate_hooks(cls, hooks: list[str]) -> list[str]:
        if len(hooks) != 3:
            raise ValueError("Exactly 3 hooks are required")
        cleaned: list[str] = []
        for i, hook in enumerate(hooks):
            text = " ".join((hook or "").split()).strip()
            if not text:
                raise ValueError(f"Hook {i + 1} is empty")
            if _word_count(text) > 12:
                raise ValueError(f"Hook {i + 1} exceeds 12 words")
            cleaned.append(text)
        return cleaned
