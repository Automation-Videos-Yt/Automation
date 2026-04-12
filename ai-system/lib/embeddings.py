from openai import OpenAI
from config import settings
from .log import get_logger, timed

log = get_logger("embeddings")
_client: OpenAI | None = None

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = 1536


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=settings.openai_api_key)
    return _client


def embed(text: str) -> list[float]:
    if not text or not text.strip():
        raise ValueError("embed() requires non-empty text")
    client = _get_client()
    with timed(log, "openai.embeddings.create", model=EMBEDDING_MODEL, chars=len(text)):
        resp = client.embeddings.create(model=EMBEDDING_MODEL, input=text)
    if not resp.data:
        raise RuntimeError("embeddings.create returned empty data")
    vec = resp.data[0].embedding
    if len(vec) != EMBEDDING_DIMS:
        log.warning("unexpected embedding dim=%d (expected %d)", len(vec), EMBEDDING_DIMS)
    return list(vec)
