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

## Runtime configuration

Runtime configuration is loaded only from the `ConflictStudio.env` file at the project root. `CONFLICTSTUDIO_DATA_ROOT`, `CONFLICTSTUDIO_LTX23_WORKFLOW_PATH`, and `CONFLICTSTUDIO_H3_WORKFLOW_PATH` are optional overrides; when unset they default to `/home/team/zhanghaonan/ConflictStudio-data`, `/home/team/lvshuyang/prompt-make/workflows/ltx23_t2v_audio_single_stage_api.json`, and `/home/team/zhanghaonan/H3-ComfyUI/output/compare-vt-va-20260806/h3/va_aligned/payload.json` respectively. The GPU endpoint ports (8188/8189) and the systemd unit allowlist remain fixed, as do the bundled LTX-2.5 workflow templates. `scripts/run.sh` validates the resolved paths (an existing writable data root, readable workflow files) instead of requiring them to equal the defaults.

Runtime runs require:

- a writable data root directory
- `ffmpeg` and `ffprobe`
- an existing Python environment
- a readable LTX-2.3 workflow file
- a readable H3 workflow file
- the two external GPU model endpoints

Build the frontend first:

```bash
npm --prefix frontend run build
```

Create the fixed configuration file:

```bash
CONFLICTSTUDIO_HOST=127.0.0.1
CONFLICTSTUDIO_PORT=8000
CONFLICTSTUDIO_PYTHON=/home/team/zhanghaonan/miniconda3/envs/mprisk/bin/python
CONFLICTSTUDIO_LTX23_WORKFLOW_PATH=/home/team/lvshuyang/prompt-make/workflows/ltx23_t2v_audio_single_stage_api.json
CONFLICTSTUDIO_H3_WORKFLOW_PATH=/home/team/zhanghaonan/H3-ComfyUI/output/compare-vt-va-20260806/h3/va_aligned/payload.json
CONFLICTSTUDIO_GPU0_URL=http://127.0.0.1:8188
CONFLICTSTUDIO_GPU1_URL=http://127.0.0.1:8189
```

Then start the server from `/home/team/zhanghaonan/ConflictStudio`:

```bash
bash scripts/run.sh
```

`scripts/run.sh` loads that fixed file, validates the prerequisites, and starts exactly one Uvicorn worker. It does not install dependencies, create directories, run migrations, or start the renderer services.

### LTX-2.5 user services

The four LTX-2.5 renderer units in `deploy/systemd` are separate BF16 and INT8 profiles for GPU0/port 8188 and GPU1/port 8189. They run `/home/team/zhanghaonan/LTX-2.5-ComfyUI` with its fixed Python 3.13 runtime. Each profile keeps its input, output, temp, user, cache, and SQLite data below `/home/team/zhanghaonan/ConflictStudio-data/comfyui`.

Install the unit files into the user's systemd directory and reload their definitions:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/conflictstudio-ltx25-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

The units are on-demand. Do not enable them. Start exactly the required profile, for example:

```bash
systemctl --user start conflictstudio-ltx25-bf16-gpu0.service
systemctl --user stop conflictstudio-ltx25-bf16-gpu0.service
```

The two LTX-2.5 profiles conflict with each other and with the existing ConflictStudio renderer units on the same GPU slot. Starting a profile therefore leaves only one ConflictStudio renderer on that slot. The unit files set these runtime variables directly:

- `CUDA_VISIBLE_DEVICES=0` or `1`
- `PYTHONPATH=/home/team/zhanghaonan/LTX-2.5-ComfyUI/.venv/lib/python3.13/site-packages`
- `XDG_CACHE_HOME` to the selected profile's data-root cache directory
- `CONFLICTSTUDIO_LTX25_PRECISION=BF16` or `INT8`

No LTX-2.5 workflow path is part of the unit configuration.
