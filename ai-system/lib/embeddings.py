from .log import get_logger, timed
from .openai_client import get_openai_client

log = get_logger("embeddings")

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = 1536


def embed(text: str) -> list[float]:
    if not text or not text.strip():
        raise ValueError("embed() requires non-empty text")
    client = get_openai_client()
    with timed(log, "openai.embeddings.create", model=EMBEDDING_MODEL, chars=len(text)):
        resp = client.embeddings.create(model=EMBEDDING_MODEL, input=text)
    if not resp.data:
        raise RuntimeError("embeddings.create returned empty data")
    vec = resp.data[0].embedding
    if len(vec) != EMBEDDING_DIMS:
        log.warning("unexpected embedding dim=%d (expected %d)", len(vec), EMBEDDING_DIMS)
    return list(vec)
