#!/usr/bin/env bash
set -euo pipefail

API="${API:-http://localhost:4000}"
NICHE="${1:-productivity hacks}"
TIMEOUT_SEC="${TIMEOUT_SEC:-300}"

echo "[smoke] POST $API/pipeline/run niche='$NICHE'"
RUN_ID=$(curl -sS -X POST "$API/pipeline/run" \
  -H 'Content-Type: application/json' \
  -d "{\"niche\": \"$NICHE\"}" | grep -oE '"id":"[^"]+"' | head -1 | cut -d'"' -f4)

if [ -z "${RUN_ID:-}" ]; then
  echo "[smoke] failed to create run" >&2
  exit 1
fi

echo "[smoke] run $RUN_ID created — polling"
DEADLINE=$(( $(date +%s) + TIMEOUT_SEC ))

while true; do
  STATE=$(curl -sS "$API/pipeline/$RUN_ID")
  STATUS=$(echo "$STATE" | grep -oE '"status":"[^"]+"' | head -1 | cut -d'"' -f4)
  STAGE=$(echo "$STATE"  | grep -oE '"stage":"[^"]+"'  | head -1 | cut -d'"' -f4)
  printf "\r[smoke] status=%s stage=%s" "$STATUS" "$STAGE"

  case "$STATUS" in
    COMPLETED)
      echo ""
      VIDEO=$(echo "$STATE" | grep -oE '"videoPath":"[^"]+"' | head -1 | cut -d'"' -f4)
      echo "[smoke] done — $VIDEO"
      exit 0
      ;;
    FAILED)
      echo ""
      echo "[smoke] run failed"
      echo "$STATE"
      exit 2
      ;;
  esac

  if [ "$(date +%s)" -gt "$DEADLINE" ]; then
    echo ""
    echo "[smoke] timeout after ${TIMEOUT_SEC}s"
    exit 3
  fi

  sleep 2
done
