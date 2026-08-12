#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT=/home/team/zhanghaonan/TAFFC/ConflictStudio-data
required=(
  CONFLICTSTUDIO_DATA_ROOT
  CONFLICTSTUDIO_HOST
  CONFLICTSTUDIO_PORT
  CONFLICTSTUDIO_PYTHON
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
if [[ "$CONFLICTSTUDIO_DATA_ROOT" != "$DATA_ROOT" ]]; then
  echo "CONFLICTSTUDIO_DATA_ROOT must equal $DATA_ROOT" >&2
  exit 1
fi
if [[ ! -d "$CONFLICTSTUDIO_DATA_ROOT" || ! -w "$CONFLICTSTUDIO_DATA_ROOT" ]]; then
  echo "CONFLICTSTUDIO_DATA_ROOT must be an existing writable directory" >&2
  exit 1
fi
mkdir -p \
  "$CONFLICTSTUDIO_DATA_ROOT/database" \
  "$CONFLICTSTUDIO_DATA_ROOT/media" \
  "$CONFLICTSTUDIO_DATA_ROOT/logs"
if [[ ! "$CONFLICTSTUDIO_PORT" =~ ^[0-9]+$ ]] || (( CONFLICTSTUDIO_PORT < 1 || CONFLICTSTUDIO_PORT > 65535 )); then
  echo "CONFLICTSTUDIO_PORT must be between 1 and 65535" >&2
  exit 1
fi

cd "$ROOT"
"$CONFLICTSTUDIO_PYTHON" -c \
  'import fastapi, httpx, jinja2, pydantic, sqlmodel, uvicorn, yaml' \
  || { echo "ConflictStudio backend dependencies are incomplete" >&2; exit 1; }

exec "$CONFLICTSTUDIO_PYTHON" -m uvicorn backend.app:create_app \
  --factory \
  --host "$CONFLICTSTUDIO_HOST" \
  --port "$CONFLICTSTUDIO_PORT"
