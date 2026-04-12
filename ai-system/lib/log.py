import logging
import os
import sys
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar

_request_id: ContextVar[str] = ContextVar("request_id", default="-")


class _ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.rid = _request_id.get()
        return True


def setup_logging() -> None:
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger()
    if getattr(root, "_yt_configured", False):
        return

    root.setLevel(level)
    for h in list(root.handlers):
        root.removeHandler(h)

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(level)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-5s [%(name)s rid=%(rid)s] %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    handler.addFilter(_ContextFilter())
    root.addHandler(handler)
    # Silence over-chatty third-party loggers.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    setattr(root, "_yt_configured", True)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def new_request_id() -> str:
    rid = uuid.uuid4().hex[:8]
    _request_id.set(rid)
    return rid


def set_request_id(rid: str) -> None:
    _request_id.set(rid)


def get_request_id() -> str:
    return _request_id.get()


@contextmanager
def timed(logger: logging.Logger, label: str, **extra):
    start = time.perf_counter()
    logger.info("%s start%s", label, _fmt_extra(extra))
    try:
        yield
    except Exception as e:
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        logger.error(
            "%s failed in %dms: %s%s", label, elapsed_ms, e, _fmt_extra(extra)
        )
        raise
    else:
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        logger.info("%s done in %dms%s", label, elapsed_ms, _fmt_extra(extra))


def _fmt_extra(extra: dict) -> str:
    if not extra:
        return ""
    parts = []
    for k, v in extra.items():
        if isinstance(v, str) and len(v) > 160:
            v = v[:160] + "…"
        parts.append(f"{k}={v}")
    return " [" + " ".join(parts) + "]"
