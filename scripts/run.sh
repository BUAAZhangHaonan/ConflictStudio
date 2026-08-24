#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$ROOT"
ENV_FILE="$PROJECT_ROOT/ConflictStudio.env"
DATA_ROOT=/home/team/zhanghaonan/ConflictStudio-data

if [[ ! -r "$ENV_FILE" ]]; then
  echo "$ENV_FILE is required and must be readable" >&2
  exit 1
fi
set -a
source "$ENV_FILE"
set +a
CONFLICTSTUDIO_DATA_ROOT="${CONFLICTSTUDIO_DATA_ROOT:-$DATA_ROOT}"

required=(
  CONFLICTSTUDIO_HOST
  CONFLICTSTUDIO_PORT
  CONFLICTSTUDIO_PYTHON
  CONFLICTSTUDIO_LLM_API_KEY
  CONFLICTSTUDIO_LTX23_WORKFLOW_PATH
  CONFLICTSTUDIO_H3_WORKFLOW_PATH
  CONFLICTSTUDIO_GPU0_URL
  CONFLICTSTUDIO_GPU1_URL
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    exit 1
  fi
done

if [[ ! -x "$CONFLICTSTUDIO_PYTHON" ]]; then
  echo "CONFLICTSTUDIO_PYTHON is not executable" >&2
  exit 1
fi
if [[ ! -d "$CONFLICTSTUDIO_DATA_ROOT" || ! -w "$CONFLICTSTUDIO_DATA_ROOT" ]]; then
  echo "CONFLICTSTUDIO_DATA_ROOT must be an existing writable directory" >&2
  exit 1
fi
if [[ ! "$CONFLICTSTUDIO_PORT" =~ ^[0-9]+$ ]] || (( CONFLICTSTUDIO_PORT < 1 || CONFLICTSTUDIO_PORT > 65535 )); then
  echo "CONFLICTSTUDIO_PORT must be between 1 and 65535" >&2
  exit 1
fi
if [[ ! -f "$ROOT/frontend/dist/index.html" ]]; then
  echo "frontend/dist is missing; run npm run build first" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required" >&2
  exit 1
fi
if ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffprobe is required" >&2
  exit 1
fi
if [[ ! -r "$CONFLICTSTUDIO_LTX23_WORKFLOW_PATH" ]]; then
  echo "The LTX-2.3 workflow file is not readable" >&2
  exit 1
fi
if [[ ! -r "$CONFLICTSTUDIO_H3_WORKFLOW_PATH" ]]; then
  echo "The H3 workflow file is not readable" >&2
  exit 1
fi

cd "$ROOT"
"$CONFLICTSTUDIO_PYTHON" -c \
  'import fastapi, httpx, jinja2, pydantic, sqlmodel, uvicorn, websockets, yaml' \
  || { echo "ConflictStudio backend dependencies are incomplete" >&2; exit 1; }

exec "$CONFLICTSTUDIO_PYTHON" -m uvicorn backend.app:create_app \
  --factory \
  --host "$CONFLICTSTUDIO_HOST" \
  --port "$CONFLICTSTUDIO_PORT" \
  --workers 1
