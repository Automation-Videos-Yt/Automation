from pydantic import BaseModel, Field


class VideoMetaInput(BaseModel):
    title: str
    angle: str
    script_body: str


class VideoMetaOutput(BaseModel):
    title: str = Field(..., max_length=100)
    description: str
    tags: list[str]
