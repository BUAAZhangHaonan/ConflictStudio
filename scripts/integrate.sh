#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURATION_PYTHON="${CURATION_PYTHON:-/home/team/zhanghaonan/miniconda3/envs/mprisk/bin/python}"

frontend() { npm --prefix "$ROOT/frontend" "$@"; }
backend() { "$CURATION_PYTHON" "$@"; }

deploy_check() {
  [[ -f "$ROOT/deploy/nginx/conflictstudio.conf" ]] || { echo "missing nginx config" >&2; return 1; }
  [[ -f "$ROOT/deploy/systemd/conflictstudio.service" ]] || { echo "missing service unit" >&2; return 1; }
  [[ -f "$ROOT/scripts/run.sh" && -x "$ROOT/scripts/run.sh" ]] || { echo "scripts/run.sh must be executable" >&2; return 1; }
  grep -q 'listen 8888' "$ROOT/deploy/nginx/conflictstudio.conf"
  grep -q 'proxy_set_header Upgrade' "$ROOT/deploy/nginx/conflictstudio.conf"
  grep -q 'proxy_pass' "$ROOT/deploy/nginx/conflictstudio.conf"
}

case "${1:-verify}" in
  typecheck) frontend run typecheck ;;
  build) frontend run build ;;
  test) backend -m unittest discover -s backend/tests ;;
  py_compile) backend -m compileall -q "$ROOT/backend" ;;
  deploy:check) deploy_check ;;
  verify)
    frontend run typecheck
    frontend run build
    backend -m unittest discover -s backend/tests
    backend -m compileall -q "$ROOT/backend"
    deploy_check
    ;;
  *) echo "usage: $0 {typecheck|build|test|py_compile|deploy:check|verify}" >&2; exit 2 ;;
esac
