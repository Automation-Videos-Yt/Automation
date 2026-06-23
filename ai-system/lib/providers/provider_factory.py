from .base_provider import BaseProvider
from .openai_provider import OpenAIProvider
from .gemini_provider import GeminiProvider

class ProviderFactory:
    _providers: dict[str, BaseProvider] = {}

    @classmethod
    def get_provider(cls, name: str) -> BaseProvider:
        if name not in cls._providers:
            if name == "openai":
                cls._providers[name] = OpenAIProvider()
            elif name == "gemini":
                cls._providers[name] = GeminiProvider()
            else:
                raise ValueError(f"Unknown provider: {name}")
        return cls._providers[name]
