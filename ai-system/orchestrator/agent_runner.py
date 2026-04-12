import time
from typing import Callable

from agents.topic import run as topic_run
from agents.script import run as script_run
from agents.hook import run as hook_run
from agents.voice import run as voice_run
from agents.timestamp import run as timestamp_run
from agents.video_selection import run as video_selection_run
from agents.video_meta import run as video_meta_run
from agents.thumbnail import run as thumbnail_run
from agents.feedback import run as feedback_run
from agents.prediction import run as prediction_run
from lib.log import get_logger

log = get_logger("orchestrator")

AgentFn = Callable[[dict], dict]


REGISTRY: dict[str, AgentFn] = {
    "topic": topic_run,
    "script": script_run,
    "hook": hook_run,
    "voice": voice_run,
    "timestamp": timestamp_run,
    "video_selection": video_selection_run,
    "video_meta": video_meta_run,
    "thumbnail": thumbnail_run,
    "feedback": feedback_run,
    "prediction": prediction_run,
}


class AgentNotFound(Exception):
    pass


def dispatch(agent_name: str, payload: dict) -> dict:
    fn = REGISTRY.get(agent_name)
    if fn is None:
        log.warning("unknown agent requested: %s (registry=%s)", agent_name, list(REGISTRY))
        raise AgentNotFound(agent_name)

    log.info("agent=%s run start keys=%s", agent_name, list(payload))
    start = time.perf_counter()
    try:
        result = fn(payload)
    except Exception:
        elapsed = int((time.perf_counter() - start) * 1000)
        log.exception("agent=%s failed after %dms", agent_name, elapsed)
        raise
    elapsed = int((time.perf_counter() - start) * 1000)
    log.info("agent=%s run done in %dms", agent_name, elapsed)
    return result
