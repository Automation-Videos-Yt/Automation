from abc import ABC, abstractmethod

class BaseProvider(ABC):
    @abstractmethod
    def chat(self, *, model: str, messages: list[dict], temperature: float = 0.7, response_format: dict | None = None) -> object:
        """
        Executes a chat completion call.
        
        Args:
            model: The name of the model to use.
            messages: A list of message dictionaries (e.g. [{"role": "user", "content": "hello"}]).
            temperature: Sampling temperature.
            response_format: Optional JSON schema for structured outputs.
            
        Returns:
            The raw response object or a mapped equivalent depending on the provider.
            The return object MUST have a structure compatible with standard OpenAI responses, 
            or the agents must be updated to handle a unified response format.
            For now, we expect a return object `resp` where `resp.choices[0].message.content` works, 
            or we return a unified string content. Let's return the string content directly.
        """
        pass
