from typing import Literal
from pydantic import BaseModel, Field


class ThumbnailInput(BaseModel):
    topic_title: str
    topic_angle: str
    script_hook: str
    output_path: str
    # gpt-image-1 only supports 1024x1024, 1024x1536, 1536x1024, auto.
    size: str = Field(default="1536x1024")
    # "high" for strong-predicted runs, "medium" for mid, "low" for weak.
    # Each step down is ~3-4x cheaper than the previous.
    quality: Literal["low", "medium", "high", "auto"] = "high"


class ThumbnailOutput(BaseModel):
    image_path: str
    prompt: str
    width: int
    height: int
    quality: str
