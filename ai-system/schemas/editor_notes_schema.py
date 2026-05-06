from __future__ import annotations

from pydantic import BaseModel, Field


class EditorNotesSceneInput(BaseModel):
    index: int = Field(..., ge=0)
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)
    text: str = Field(..., min_length=1)


class EditorNotesInput(BaseModel):
    language_code: str = Field(default="en", min_length=2, max_length=10)
    hook: str = Field(default="")
    script: str = Field(..., min_length=20)
    target_duration_sec: int | None = Field(default=None, ge=1, le=300)
    scenes: list[EditorNotesSceneInput] = Field(default_factory=list)


class EditorNotesSceneOutput(BaseModel):
    index: int = Field(..., ge=0)
    emotion_beat: str = Field(..., min_length=1, max_length=80)
    on_screen_text: list[str] = Field(default_factory=list, description="1-3 short overlays")
    b_roll: list[str] = Field(default_factory=list, description="2-5 b-roll ideas/keywords")
    sfx_music: list[str] = Field(default_factory=list, description="1-4 sound/music cues")
    transition: str = Field(default="", description="Optional quick transition note")


class EditorNotesOutput(BaseModel):
    dominant_emotion: str = Field(..., min_length=2, max_length=24)
    pace: str = Field(..., min_length=2, max_length=24)
    global_notes: list[str] = Field(default_factory=list)
    scene_notes: list[EditorNotesSceneOutput] = Field(default_factory=list)
    caption_emphasis: list[str] = Field(default_factory=list, description="Key words/phrases to emphasize")
