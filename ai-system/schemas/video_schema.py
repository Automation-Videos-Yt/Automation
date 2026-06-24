from pydantic import BaseModel, Field


class VideoMetaInput(BaseModel):
    title: str
    angle: str
    script_body: str
    language_code: str = Field(default="en", min_length=2, max_length=10)
    use_cache: bool = Field(default=True)


class VideoMetaOutput(BaseModel):
    title: str = Field(..., max_length=100)
    description: str
    tags: list[str]
