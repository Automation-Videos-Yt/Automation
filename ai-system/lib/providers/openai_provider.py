from openai import APIError, APITimeoutError, RateLimitError
from config import settings
from lib.openai_client import get_openai_client
from lib.log import get_logger
from .base_provider import BaseProvider

log = get_logger("openai_provider")

class OpenAIProvider(BaseProvider):
    def __init__(self):
        self.client = get_openai_client()

    def chat(self, *, model: str, messages: list[dict], temperature: float = 0.7, response_format: dict | None = None) -> object:
        kwargs = {"messages": messages, "temperature": temperature}
        if response_format:
            kwargs["response_format"] = response_format

        log.info("openai generating content model=%s", model)
        response = self.client.chat.completions.create(model=model, **kwargs)
        
        usage = getattr(response, "usage", None)
        if usage:
            from lib.llm import usage_stats_var
            usage_stats_var.set({
                "model": model,
                "prompt_tokens": usage.prompt_tokens,
                "completion_tokens": usage.completion_tokens,
                "total_tokens": usage.total_tokens,
            })
            
        return response
