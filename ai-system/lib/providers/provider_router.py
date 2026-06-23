import time
from .provider_factory import ProviderFactory
from lib.provider_health import health_monitor
from lib.model_router import TaskType, get_provider_candidates, get_model_for_provider, get_fallback_model_for_provider
from lib.log import get_logger

log = get_logger("provider_router")

class ProviderRouter:
    @classmethod
    def chat(cls, *, task_type: TaskType, messages: list[dict], temperature: float = 0.7, response_format: dict | None = None) -> object:
        """
        Orchestrates cross-provider fallback and selects the best provider based on health metrics.
        Deterministic routing (like script_writing) is handled by restricting the provider candidates in model_router.py.
        """
        candidates = get_provider_candidates(task_type)
        if not candidates:
            raise ValueError(f"No providers configured for task {task_type}")

        # If it's a deterministic task (only 1 candidate provider), we don't use health to switch providers.
        # But if there are multiple, we pick the healthiest.
        primary_provider_name = candidates[0] if len(candidates) == 1 else health_monitor.get_healthiest_provider(candidates)
        fallback_provider_names = [p for p in candidates if p != primary_provider_name]
        
        last_err = None
        for provider_name in [primary_provider_name] + fallback_provider_names:
            provider = ProviderFactory.get_provider(provider_name)
            
            # Within the same provider, we might have a primary model and a fallback model (e.g. gpt-4o -> gpt-4o-mini)
            primary_model = get_model_for_provider(provider_name, task_type)
            fallback_model = get_fallback_model_for_provider(provider_name, task_type)
            
            models_to_try = [primary_model]
            if fallback_model and fallback_model != primary_model:
                models_to_try.append(fallback_model)
                
            for attempt, model in enumerate(models_to_try):
                start_time = time.perf_counter()
                try:
                    log.info("routing task=%s provider=%s model=%s", task_type.value, provider_name, model)
                    response = provider.chat(
                        model=model,
                        messages=messages,
                        temperature=temperature,
                        response_format=response_format
                    )
                    latency = int((time.perf_counter() - start_time) * 1000)
                    health_monitor.record_result(provider=provider_name, success=True, latency_ms=latency)
                    return response
                except Exception as e:
                    last_err = e
                    latency = int((time.perf_counter() - start_time) * 1000)
                    health_monitor.record_result(provider=provider_name, success=False, latency_ms=latency)
                    log.warning("provider=%s model=%s failed: %s", provider_name, model, str(e))
                    
        raise Exception(f"All providers exhausted for task {task_type}. Last error: {str(last_err)}")
