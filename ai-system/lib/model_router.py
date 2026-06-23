from enum import Enum

class TaskType(Enum):
    TOPIC_GENERATION = "topic_generation"
    HOOK_GENERATION = "hook_generation"
    SCRIPT_WRITING = "script_writing"
    SCRIPT_EVALUATION = "script_evaluation"
    PERFORMANCE_PREDICTION = "performance_prediction"
    AUTOPILOT = "autopilot"
    VIDEO_SELECTION = "video_selection"
    VIDEO_META = "video_meta"
    EMBEDDINGS = "embeddings"
    TTS_HD = "tts_hd"
    TTS_BUDGET = "tts_budget"

# Default provider fallback chains per task
TASK_PROVIDERS = {
    TaskType.TOPIC_GENERATION: ["gemini", "groq", "openrouter", "openai"],
    TaskType.HOOK_GENERATION: ["gemini", "groq", "openrouter", "openai"],
    TaskType.SCRIPT_WRITING: ["gemini", "groq", "openrouter", "openai"], # fallback to gemini if openai fails
    TaskType.SCRIPT_EVALUATION: ["gemini", "groq", "openrouter", "openai"],
    TaskType.PERFORMANCE_PREDICTION: ["gemini", "groq", "openrouter", "openai"],
    TaskType.AUTOPILOT: ["gemini", "groq", "openrouter", "openai"],
    TaskType.VIDEO_SELECTION: ["gemini", "groq", "openrouter", "openai"],
    TaskType.VIDEO_META: ["gemini", "groq", "openrouter", "openai"],
    TaskType.EMBEDDINGS: ["openai"],
    TaskType.TTS_HD: ["openai"],
    TaskType.TTS_BUDGET: ["openai"]
}

PROVIDER_MODELS = {
    "gemini": {
        TaskType.TOPIC_GENERATION: "gemini-2.5-flash",
        TaskType.HOOK_GENERATION: "gemini-2.5-flash",
        TaskType.SCRIPT_WRITING: "gemini-2.5-flash", 
        TaskType.SCRIPT_EVALUATION: "gemini-2.5-flash",
        TaskType.PERFORMANCE_PREDICTION: "gemini-2.5-flash",
        TaskType.AUTOPILOT: "gemini-2.5-flash",
        TaskType.VIDEO_SELECTION: "gemini-2.5-flash",
        TaskType.VIDEO_META: "gemini-2.5-flash",
    },
    "groq": {
        TaskType.TOPIC_GENERATION: "llama-3.1-8b-instant",
        TaskType.HOOK_GENERATION: "llama-3.1-8b-instant",
        TaskType.SCRIPT_WRITING: "llama-3.3-70b-versatile", 
        TaskType.SCRIPT_EVALUATION: "llama-3.1-8b-instant",
        TaskType.PERFORMANCE_PREDICTION: "llama-3.1-8b-instant",
        TaskType.AUTOPILOT: "llama-3.1-8b-instant",
        TaskType.VIDEO_SELECTION: "llama-3.3-70b-versatile",
        TaskType.VIDEO_META: "llama-3.1-8b-instant",
    },
    "openrouter": {
        TaskType.TOPIC_GENERATION: "meta-llama/llama-3.3-70b-instruct:free",
        TaskType.HOOK_GENERATION: "meta-llama/llama-3.3-70b-instruct:free",
        TaskType.SCRIPT_WRITING: "meta-llama/llama-3.3-70b-instruct:free", 
        TaskType.SCRIPT_EVALUATION: "meta-llama/llama-3.3-70b-instruct:free",
        TaskType.PERFORMANCE_PREDICTION: "meta-llama/llama-3.3-70b-instruct:free",
        TaskType.AUTOPILOT: "meta-llama/llama-3.3-70b-instruct:free",
        TaskType.VIDEO_SELECTION: "meta-llama/llama-3.3-70b-instruct:free",
        TaskType.VIDEO_META: "meta-llama/llama-3.3-70b-instruct:free",
    },
    "openai": {
        TaskType.TOPIC_GENERATION: "gpt-4o-mini",
        TaskType.HOOK_GENERATION: "gpt-4o-mini",
        TaskType.SCRIPT_WRITING: "gpt-4o", # primary
        TaskType.SCRIPT_EVALUATION: "gpt-4o-mini",
        TaskType.PERFORMANCE_PREDICTION: "gpt-4o-mini",
        TaskType.AUTOPILOT: "gpt-4o-mini",
        TaskType.VIDEO_SELECTION: "gpt-4o-mini",
        TaskType.VIDEO_META: "gpt-4o-mini",
        TaskType.EMBEDDINGS: "text-embedding-3-small",
        TaskType.TTS_HD: "tts-1-hd",
        TaskType.TTS_BUDGET: "tts-1"
    }
}

# For script writing, we want openai gpt-4o falling back to gpt-4o-mini within the SAME provider
PROVIDER_MODEL_FALLBACKS = {
    "openai": {
        TaskType.SCRIPT_WRITING: "gpt-4o-mini"
    }
}

def get_provider_candidates(task: TaskType) -> list[str]:
    return TASK_PROVIDERS.get(task, ["openai"])

def get_model_for_provider(provider: str, task: TaskType) -> str:
    return PROVIDER_MODELS.get(provider, {}).get(task, "gpt-4o-mini")

def get_fallback_model_for_provider(provider: str, task: TaskType) -> str | None:
    return PROVIDER_MODEL_FALLBACKS.get(provider, {}).get(task)
