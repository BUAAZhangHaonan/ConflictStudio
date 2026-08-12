# ConflictStudio

ConflictStudio is a local app for generating, reviewing, and archiving media samples.

## Local Development

Install dependencies into the existing environments first. Do not let the run script install packages for you.

```bash
npm --prefix frontend install --no-package-lock
python -m pip install -e "./backend[test]"
```

The frontend dev server only serves the Vite app. It does not proxy `/api`.

```bash
npm run dev
```

The same FastAPI server serves the frontend build, API routes, WebSocket routes, and media files on one port. Build the frontend first, then run the focused checks:

```bash
npm run check
python -m pytest -q backend/tests
python -m compileall -q backend
```

## Temporary Deployment

Temporary runs require:

- a writable data root at `/home/team/zhanghaonan/TAFFC/ConflictStudio-data`
- `ffprobe`, used only to validate generated media
- an existing Python environment
- the fixed LTX-2.3 workflow file
- the fixed H3 workflow file
- the two external GPU model endpoints

Build the frontend first:

```bash
npm run build
```

Then set the runtime variables and start the server:

```bash
export CONFLICTSTUDIO_DATA_ROOT=/home/team/zhanghaonan/TAFFC/ConflictStudio-data
export CONFLICTSTUDIO_HOST=127.0.0.1
export CONFLICTSTUDIO_PORT=8000
export CONFLICTSTUDIO_PYTHON=/home/team/zhanghaonan/miniconda3/envs/mprisk/bin/python
export CONFLICTSTUDIO_LTX23_WORKFLOW_PATH=/home/team/lvshuyang/prompt-make/workflows/ltx23_t2v_audio_single_stage_api.json
export CONFLICTSTUDIO_H3_WORKFLOW_PATH=/home/team/zhanghaonan/H3-ComfyUI/output/compare-vt-va-20260806/h3/va_aligned/payload.json
export CONFLICTSTUDIO_GPU0_URL=http://127.0.0.1:8188
export CONFLICTSTUDIO_GPU1_URL=http://127.0.0.1:8189
bash scripts/run.sh
```

`scripts/run.sh` only validates these prerequisites and starts exactly one Uvicorn worker. It does not install dependencies, create directories, run migrations, or start the renderer services.
