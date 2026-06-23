import time
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from lib.log import setup_logging, get_logger, new_request_id, get_request_id, set_request_id
from lib.embeddings import embed, EMBEDDING_DIMS, EMBEDDING_MODEL
from lib.llm import usage_stats_var
from orchestrator.agent_runner import AgentNotFound, dispatch

setup_logging()
log = get_logger("ai-system")

app = FastAPI(title="youtube-automation-ai", version="0.1.0")


@app.middleware("http")
async def request_logger(request: Request, call_next):
    incoming = request.headers.get("x-request-id")
    rid = incoming or new_request_id()
    set_request_id(rid)
    start = time.perf_counter()
    log.info("-> %s %s", request.method, request.url.path)
    try:
        response = await call_next(request)
    except Exception:
        elapsed = int((time.perf_counter() - start) * 1000)
        log.exception("<- %s %s errored in %dms", request.method, request.url.path, elapsed)
        raise
    elapsed = int((time.perf_counter() - start) * 1000)
    log.info(
        "<- %s %s %d in %dms",
        request.method,
        request.url.path,
        response.status_code,
        elapsed,
    )
    response.headers["x-request-id"] = rid
    
    usage = usage_stats_var.get()
    if usage:
        response.headers["x-openai-model"] = usage.get("model", "")
        response.headers["x-openai-prompt-tokens"] = str(usage.get("prompt_tokens", 0))
        response.headers["x-openai-completion-tokens"] = str(usage.get("completion_tokens", 0))
        if usage.get("prompt_version"):
            response.headers["x-ai-prompt-version"] = str(usage.get("prompt_version"))
        
    return response


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/embeddings")
async def embeddings(request: Request) -> dict:
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="body must be {text: string}")
    try:
        vec = embed(text)
    except Exception as e:
        log.exception("embed failed")
        raise HTTPException(status_code=500, detail=str(e))
    return {"model": EMBEDDING_MODEL, "dims": EMBEDDING_DIMS, "embedding": vec}


@app.post("/agents/{agent_name}/run")
async def run_agent(agent_name: str, request: Request) -> object:
    try:
        payload = await request.json()
    except Exception:
        log.warning("invalid JSON body for agent=%s", agent_name)
        raise HTTPException(status_code=400, detail="invalid JSON body")

    if not isinstance(payload, dict):
        log.warning("non-object payload for agent=%s type=%s", agent_name, type(payload).__name__)
        raise HTTPException(status_code=400, detail="payload must be an object")

    started = time.perf_counter()
    try:
        log.info("dispatch agent=%s", agent_name)
        result = dispatch(agent_name, payload)
    except AgentNotFound:
        log.warning("agent not found: %s", agent_name)
        raise HTTPException(status_code=404, detail=f"agent '{agent_name}' not found")
    except ValidationError as ve:
        log.warning("agent=%s input validation failed: %s", agent_name, ve.errors())
        raise HTTPException(status_code=400, detail=ve.errors())
    except Exception as e:
        log.exception("agent=%s failed", agent_name)
        raise HTTPException(status_code=500, detail="An unexpected internal server error occurred")

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    log.info("agent=%s ok in %dms", agent_name, elapsed_ms)
    return result


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error rid=%s", get_request_id())
    return JSONResponse(
        status_code=500, 
        content={"error": "InternalServerError", "detail": "An unexpected internal server error occurred"}
    )
