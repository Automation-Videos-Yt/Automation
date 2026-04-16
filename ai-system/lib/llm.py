import time
from openai import APIError, APITimeoutError, RateLimitError
from config import settings
from .openai_client import get_openai_client
from .log import get_logger

log = get_logger("llm")


def chat_with_fallback(
    *,
    primary_model: str,
    fallback_model: str | None,
    messages: list[dict],
    response_format: dict | None = None,
    temperature: float = 0.7,
    attempts: int = 2,
):
    """
    Call chat.completions with:
      - automatic retry on transient errors (rate limits, timeouts, 5xx) per model
      - automatic fallback to a cheaper model if the primary keeps failing

    Non-retryable errors (400 bad requests, schema violations) propagate immediately.
    """
    client = get_openai_client()
    kwargs = {"messages": messages, "temperature": temperature}
    if response_format:
        kwargs["response_format"] = response_format

    def try_once(model: str, attempt: int):
        log.info("chat attempt model=%s attempt=%d", model, attempt)
        return client.chat.completions.create(model=model, **kwargs)

    candidates = [primary_model]
    if fallback_model and fallback_model != primary_model:
        candidates.append(fallback_model)

    last_err: Exception | None = None
    for ci, model in enumerate(candidates):
        for attempt in range(1, attempts + 1):
            try:
                return try_once(model, attempt)
            except (APITimeoutError, RateLimitError) as e:
                last_err = e
                wait = 0.75 * (2 ** (attempt - 1))
                log.warning(
                    "transient error on %s attempt %d: %s — waiting %.1fs",
                    model,
                    attempt,
                    type(e).__name__,
                    wait,
                )
                time.sleep(wait)
            except APIError as e:
                last_err = e
                status = getattr(e, "status_code", None)
                if status is not None and status >= 500:
                    wait = 0.75 * (2 ** (attempt - 1))
                    log.warning(
                        "server error %s on %s attempt %d — waiting %.1fs",
                        status,
                        model,
                        attempt,
                        wait,
                    )
                    time.sleep(wait)
                else:
                    # 4xx: not retryable, not fallback-eligible (schema bug).
                    raise
        # Exhausted attempts on this model; try next candidate if any.
        if ci < len(candidates) - 1:
            log.warning(
                "primary model %s exhausted retries — falling back to %s",
                model,
                candidates[ci + 1],
            )

    assert last_err is not None
    raise last_err
