from pydantic import BaseModel, Field


class RetentionOptimizerInput(BaseModel):
    script: str = Field(..., min_length=20)
    language_code: str = Field(default="en", min_length=2, max_length=10)


class RetentionOptimizerOutput(BaseModel):
    improved_script: str = Field(..., min_length=1)
