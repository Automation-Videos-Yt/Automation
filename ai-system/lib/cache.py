import json
import hashlib
import redis
import psycopg2
from typing import Any
from config import settings
from lib.log import get_logger

log = get_logger("cache")

class AiCache:
    def __init__(self):
        self.enabled = True # Would normally come from env ENABLE_CACHE
        self.redis_client = None
        self.db_conn = None
        
        try:
            self.redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
            self.redis_client.ping()
        except Exception as e:
            log.warning("Failed to connect to Redis for L1 cache: %s", e)
            self.redis_client = None

        if settings.database_url:
            try:
                self.db_conn = psycopg2.connect(settings.database_url)
                self.db_conn.autocommit = True
            except Exception as e:
                log.warning("Failed to connect to Postgres for L2 cache: %s", e)
                self.db_conn = None

    def _get_ttl_for_task(self, task_type: str) -> int:
        if task_type in ("topic_generation", "hook_generation"):
            return 30 * 24 * 60 * 60 # 30 days
        elif task_type == "script_evaluation":
            return 7 * 24 * 60 * 60 # 7 days
        return 24 * 60 * 60 # 1 day default

    def get(self, task_type: str, input_hash: str) -> dict | None:
        if not self.enabled:
            return None

        # Try L1
        if self.redis_client:
            try:
                key = f"aicache:{task_type}:{input_hash}"
                val = self.redis_client.get(key)
                if val:
                    return json.loads(val)
            except Exception as e:
                log.error("Redis get failed: %s", e)

        # Try L2
        if self.db_conn:
            try:
                with self.db_conn.cursor() as cur:
                    cur.execute(
                        'SELECT output FROM "AiCache" WHERE "taskType" = %s AND "inputHash" = %s',
                        (task_type, input_hash)
                    )
                    row = cur.fetchone()
                    if row and row[0]:
                        val = row[0]
                        # Populate L1 from L2
                        if self.redis_client:
                            key = f"aicache:{task_type}:{input_hash}"
                            self.redis_client.setex(key, self._get_ttl_for_task(task_type), json.dumps(val))
                        return val
            except Exception as e:
                log.error("Postgres L2 get failed: %s", e)

        return None

    def set(self, task_type: str, input_hash: str, output: dict, provider: str, model: str):
        if not self.enabled:
            return

        # Set L1
        if self.redis_client:
            try:
                key = f"aicache:{task_type}:{input_hash}"
                self.redis_client.setex(key, self._get_ttl_for_task(task_type), json.dumps(output))
            except Exception as e:
                log.error("Redis set failed: %s", e)

        # Set L2
        if self.db_conn:
            try:
                with self.db_conn.cursor() as cur:
                    cur.execute(
                        '''
                        INSERT INTO "AiCache" ("id", "taskType", "inputHash", "output", "provider", "model", "createdAt")
                        VALUES (gen_random_uuid()::text, %s, %s, %s::jsonb, %s, %s, NOW())
                        ON CONFLICT ("taskType", "inputHash") DO NOTHING
                        ''',
                        (task_type, input_hash, json.dumps(output), provider, model)
                    )
            except Exception as e:
                log.error("Postgres L2 set failed: %s", e)

def generate_hash(messages: list[dict]) -> str:
    s = json.dumps(messages, sort_keys=True)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

ai_cache = AiCache()
