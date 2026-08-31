#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PYTHON="${CONFLICTSTUDIO_PYTHON:-python}"

frontend() { npm --prefix "$ROOT/frontend" "$@"; }
backend() { "$BACKEND_PYTHON" "$@"; }

deploy_check() {
  local service="$ROOT/deploy/systemd/conflictstudio.service"
  [[ -f "$service" ]] || { echo "missing service unit" >&2; return 1; }
  [[ -f "$ROOT/scripts/run.sh" && -x "$ROOT/scripts/run.sh" ]] || { echo "scripts/run.sh must be executable" >&2; return 1; }
  for name in CONFLICTSTUDIO_DATA_ROOT CONFLICTSTUDIO_HOST CONFLICTSTUDIO_PORT CONFLICTSTUDIO_PYTHON; do
    grep -q "^Environment=$name=" "$service"
  done
  grep -qx 'WorkingDirectory=/home/team/zhanghaonan/ConflictStudio' "$service"
  grep -qx 'Environment=CONFLICTSTUDIO_DATA_ROOT=/home/team/zhanghaonan/ConflictStudio-data' "$service"
  grep -qx 'EnvironmentFile=/home/team/zhanghaonan/ConflictStudio/ConflictStudio.env' "$service"
  grep -qx 'ExecStart=/home/team/zhanghaonan/ConflictStudio/scripts/run.sh' "$service"
  grep -qx 'Environment=CONFLICTSTUDIO_LTX23_WORKFLOW_PATH=/home/team/lvshuyang/prompt-make/workflows/ltx23_t2v_audio_single_stage_api.json' "$service"
  grep -qx 'Environment=CONFLICTSTUDIO_H3_WORKFLOW_PATH=/home/team/zhanghaonan/ConflictStudio-data/workflows/h3_payload.json' "$service"
}

case "${1:-verify}" in
  typecheck) frontend run typecheck ;;
  build) frontend run build ;;
  test) backend -m pytest -q "$ROOT/backend/tests" ;;
  py_compile) backend -m compileall -q "$ROOT/backend" ;;
  deploy:check) deploy_check ;;
  verify)
    frontend run typecheck
    frontend run build
    backend -m pytest -q "$ROOT/backend/tests"
    backend -m compileall -q "$ROOT/backend"
    deploy_check
    ;;
  *) echo "usage: $0 {typecheck|build|test|py_compile|deploy:check|verify}" >&2; exit 2 ;;
esac
