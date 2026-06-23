from openai import OpenAI
from config import settings
from lib.log import get_logger
from .base_provider import BaseProvider

log = get_logger("groq_provider")

class GroqProvider(BaseProvider):
    def __init__(self):
        if not settings.groq_api_key:
            raise ValueError("API key must be set when using the Groq API.")
        self.client = OpenAI(
            base_url="https://api.groq.com/openai/v1",
            api_key=settings.groq_api_key
        )

    def chat(self, *, model: str, messages: list[dict], temperature: float = 0.7, response_format: dict | None = None) -> object:
        kwargs = {"messages": messages, "temperature": temperature}
        
        # Groq does not support strict OpenAI json_schema. We degrade to json_object.
        if response_format:
            if response_format.get("type") == "json_schema":
                kwargs["response_format"] = {"type": "json_object"}
            else:
                kwargs["response_format"] = response_format

        log.info("groq generating content model=%s", model)
        response = self.client.chat.completions.create(model=model, **kwargs)
        
        usage = getattr(response, "usage", None)
        if usage:
            from lib.llm import usage_stats_var
            usage_stats_var.set({
                "model": model,
                "prompt_tokens": getattr(usage, "prompt_tokens", 0),
                "completion_tokens": getattr(usage, "completion_tokens", 0),
                "total_tokens": getattr(usage, "total_tokens", 0),
            })
            
        return response
