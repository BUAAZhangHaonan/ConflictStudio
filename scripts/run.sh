#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${CURATION_PYTHON:-/home/team/zhanghaonan/miniconda3/envs/mprisk/bin/python}"

exec "$PYTHON" "$ROOT/backend/app.py"
