#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[bootstrap] created .env from .env.example — fill in OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID"
  exit 1
fi

docker compose up --build
