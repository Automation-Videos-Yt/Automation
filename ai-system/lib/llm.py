import json
import contextvars
from config import settings
from .log import get_logger
from .model_router import TaskType
from .providers.provider_router import ProviderRouter
from .cache import ai_cache, generate_hash
from .prompt_registry import PromptVersion

log = get_logger("llm")

usage_stats_var = contextvars.ContextVar("usage_stats", default={})

def chat(
    *,
    task_type: TaskType,
    prompt_version: PromptVersion | None = None,
    messages: list[dict],
    response_format: dict | None = None,
    temperature: float = 0.7,
    response_model=None,
    use_cache: bool = True,
):
    """
    Facade for all agent chat completions.
    1. Checks semantic cache (L1 Redis + L2 Postgres)
    2. Routes to appropriate provider (OpenAI / Gemini) via ProviderRouter
    3. Handles Fallbacks (handled inside ProviderRouter)
    4. Sets usage statistics context for tracking
    """
    input_hash = generate_hash(messages)
    
    # Cache Check
    cached_output = None
    if use_cache:
        cached_output = ai_cache.get(task_type.value, input_hash)
        if cached_output:
            if response_model:
                try:
                    response_model.model_validate(cached_output)
                except Exception as e:
                    log.warning("Ignoring invalid cached output for task=%s hash=%s: %s", task_type.value, input_hash, e)
                    cached_output = None

    if cached_output:
        log.info("cache hit task=%s hash=%s", task_type.value, input_hash)
        
        # Populate context var with cache metadata (0 cost)
        usage_stats_var.set({
            "model": "cache",
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "prompt_version": prompt_version.value if prompt_version else ""
        })
        
        # To match the return type, we build a dummy unified response
        class _MockMsg:
            def __init__(self, content): self.content = content
        class _MockChoice:
            def __init__(self, content): self.message = _MockMsg(content)
        class _MockResp:
            def __init__(self, content): self.choices = [_MockChoice(content)]
            
        # We assume the cached output is a dictionary that we serialized to JSON.
        # So we turn it back into a string because agents expect a string content.
        return _MockResp(json.dumps(cached_output))

    # Real LLM Call
    response = ProviderRouter.chat(
        task_type=task_type,
        messages=messages,
        temperature=temperature,
        response_format=response_format
    )
    
    # We grab the usage stats that the provider set
    stats = usage_stats_var.get()
    
    # Inject prompt version
    if prompt_version:
        stats["prompt_version"] = prompt_version.value
        usage_stats_var.set(stats)
        
    # Store in Cache if it's a JSON response (so we can safely serialize it)
    content = response.choices[0].message.content
    try:
        data = json.loads(content)
        if response_model:
            response_model.model_validate(data) # Only cache if it passes validation
        
        if use_cache:
            ai_cache.set(
                task_type=task_type.value,
                input_hash=input_hash,
                output=data,
                provider=stats.get("model", ""), # rough heuristic
                model=stats.get("model", "")
            )
    except json.JSONDecodeError:
        log.warning("could not cache response because it is not valid JSON")
    except Exception as e:
        log.warning("could not cache response due to validation error: %s", e)
        
    return response
