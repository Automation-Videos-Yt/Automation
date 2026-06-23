import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    google_api_key: str = os.getenv("GOOGLE_API_KEY", "")
    openai_model_fast: str = os.getenv("OPENAI_MODEL_FAST", "gpt-4o-mini")
    openai_model_quality: str = os.getenv("OPENAI_MODEL_QUALITY", "gpt-4o")
    elevenlabs_api_key: str = os.getenv("ELEVENLABS_API_KEY", "")
    elevenlabs_voice_id: str = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
    pexels_api_key: str = os.getenv("PEXELS_API_KEY", "")
    storage_path: str = os.getenv("STORAGE_PATH", "/storage")
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    database_url: str = os.getenv("DATABASE_URL", "")

settings = Settings()
