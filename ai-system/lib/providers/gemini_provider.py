import json
from google import genai
from google.genai import types
from config import settings
from lib.log import get_logger
from .base_provider import BaseProvider

log = get_logger("gemini_provider")

class UnifiedMessage:
    def __init__(self, content: str):
        self.content = content

class UnifiedChoice:
    def __init__(self, content: str):
        self.message = UnifiedMessage(content)

class UnifiedResponse:
    def __init__(self, content: str):
        self.choices = [UnifiedChoice(content)]

class GeminiProvider(BaseProvider):
    def __init__(self):
        self.client = genai.Client(api_key=settings.google_api_key)

    def _convert_messages(self, messages: list[dict]) -> list[types.Content]:
        # Google GenAI uses Content objects. System instructions are handled via config.
        contents = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            # map system to user since we'll extract system prompt separately if needed, 
            # or handle it natively if SDK supports system_instruction.
            if role == "system":
                # In google-genai, system instruction goes into GenerateContentConfig.
                # So we skip it here and handle it in the chat method.
                continue
            
            gemini_role = "user" if role == "user" else "model"
            contents.append(
                types.Content(
                    role=gemini_role,
                    parts=[types.Part.from_text(text=content)]
                )
            )
        return contents

    def _extract_system_prompt(self, messages: list[dict]) -> str | None:
        for msg in messages:
            if msg.get("role") == "system":
                return msg.get("content")
        return None

    def _convert_schema(self, response_format: dict) -> types.Schema | None:
        if not response_format:
            return None
        # Convert standard JSON schema to Gemini Schema
        schema_dict = response_format.get("json_schema", {}).get("schema", {})
        if not schema_dict:
            return None
        
        def to_gemini_type(t: str):
            t = t.lower()
            if t == "string": return types.Type.STRING
            if t == "integer": return types.Type.INTEGER
            if t == "number": return types.Type.NUMBER
            if t == "boolean": return types.Type.BOOLEAN
            if t == "array": return types.Type.ARRAY
            if t == "object": return types.Type.OBJECT
            return types.Type.UNSPECIFIED

        def build_schema(d: dict) -> types.Schema:
            t = d.get("type", "object")
            schema = types.Schema(type=to_gemini_type(t))
            
            if "description" in d:
                schema.description = d["description"]
            if "enum" in d:
                schema.enum = d["enum"]
            if "properties" in d:
                schema.properties = {k: build_schema(v) for k, v in d["properties"].items()}
            if "required" in d:
                schema.required = d["required"]
            if "items" in d:
                schema.items = build_schema(d["items"])
                
            return schema

        return build_schema(schema_dict)

    def chat(self, *, model: str, messages: list[dict], temperature: float = 0.7, response_format: dict | None = None) -> object:
        system_instruction = self._extract_system_prompt(messages)
        contents = self._convert_messages(messages)
        
        config_dict = {
            "temperature": temperature,
        }
        
        if system_instruction:
            config_dict["system_instruction"] = system_instruction
            
        if response_format:
            config_dict["response_mime_type"] = "application/json"
            schema = self._convert_schema(response_format)
            if schema:
                config_dict["response_schema"] = schema
                
        config = types.GenerateContentConfig(**config_dict)
        
        log.info("gemini generating content model=%s", model)
        response = self.client.models.generate_content(
            model=model,
            contents=contents,
            config=config
        )
        
        usage = getattr(response, "usage_metadata", None)
        if usage:
            from lib.llm import usage_stats_var
            usage_stats_var.set({
                "model": model,
                "prompt_tokens": usage.prompt_token_count,
                "completion_tokens": usage.candidates_token_count,
                "total_tokens": usage.total_token_count,
            })
            
        content = response.text
        return UnifiedResponse(content)
