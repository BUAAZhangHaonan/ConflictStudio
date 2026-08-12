#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT=/home/team/zhanghaonan/TAFFC/ConflictStudio-data
LTX23_WORKFLOW_PATH=/home/team/lvshuyang/prompt-make/workflows/ltx23_t2v_audio_single_stage_api.json
H3_WORKFLOW_PATH=/home/team/zhanghaonan/H3-ComfyUI/output/compare-vt-va-20260806/h3/va_aligned/payload.json
required=(
  CONFLICTSTUDIO_DATA_ROOT
  CONFLICTSTUDIO_HOST
  CONFLICTSTUDIO_PORT
  CONFLICTSTUDIO_PYTHON
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
if [[ "$CONFLICTSTUDIO_DATA_ROOT" != "$DATA_ROOT" ]]; then
  echo "CONFLICTSTUDIO_DATA_ROOT must equal $DATA_ROOT" >&2
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
if [[ "$CONFLICTSTUDIO_LTX23_WORKFLOW_PATH" != "$LTX23_WORKFLOW_PATH" ]]; then
  echo "CONFLICTSTUDIO_LTX23_WORKFLOW_PATH must equal $LTX23_WORKFLOW_PATH" >&2
  exit 1
fi
if [[ "$CONFLICTSTUDIO_H3_WORKFLOW_PATH" != "$H3_WORKFLOW_PATH" ]]; then
  echo "CONFLICTSTUDIO_H3_WORKFLOW_PATH must equal $H3_WORKFLOW_PATH" >&2
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
