# ConflictStudio 新会话交接

更新日期：2026 年 8 月 24 日

审计对象：6403 上的唯一规范仓库 `/home/team/zhanghaonan/ConflictStudio`

审计方式：只读检查 Git、源代码、SQLite（`mode=ro`）和 `deploy/systemd/` 单元，加上已确认的运行时事实。本轮除本文档外没有修改业务代码。服务重启、npm、pytest、Playwright 是否执行以任务清单为准，本文只记录已确认的事实。

## 1. 项目目标与边界

ConflictStudio 是一个本地全栈工具。它负责组织生成配置、提交视频生成任务、查看结果、审核正式样本、同步归档和查看审核统计。

边界必须保持清楚：

- 测试任务和正式生成是两条数据链。`PromptTest` 和 `VideoTest` 不能产生正式样本，也不能进入审核或归档。只有 `Production` 完成项可以产生 `samples`。
- 前端只能调用本仓库 FastAPI 提供的接口。模型、工作流、端口和凭据由服务端固定配置。不要让浏览器提交任意 endpoint、model、workflow 或 key。
- 审核历史是追加记录。不要覆盖旧审核。类别转换和"待审核"不是同一件事。
- 归档以正式数据集为单位。当前数据库没有归档记录。
- 8888 是旧系统的保护边界，不属于本仓库。本项目入口是 8890。不要重启、替换、代理或探测性修改 8888。
- 只写当前事实。旧交接的乐观结论不能沿用。

## 2. 唯一代码、数据和配置位置

| 项目 | 当前事实 |
| --- | --- |
| 代码仓库 | `/home/team/zhanghaonan/ConflictStudio` |
| 数据根目录 | `/home/team/zhanghaonan/ConflictStudio-data`（可用 `CONFLICTSTUDIO_DATA_ROOT` 覆盖，默认不变） |
| SQLite | `/home/team/zhanghaonan/ConflictStudio-data/database/conflictstudio.sqlite3` |
| 运行配置 | `/home/team/zhanghaonan/ConflictStudio/ConflictStudio.env`，不提交，不输出密钥 |
| remote | `origin git@github.com:BUAAZhangHaonan/ConflictStudio.git` |
| branch | `master`，本轮提交前工作树干净，HEAD 为 `414fc9c` |
| 本轮业务基线 | `ca22050e8c08453b2fcd092b93e5861dcda4f1b2`（上一轮文档提交） |

不要复制仓库、数据目录或配置文件来做第二套运行环境。

### Git push 现实

6403 无法直连 github.com（22 和 443 都超时，本机 mihomo 127.0.0.1:7890 当前不可用）。推送流程固定为：在能联网的机器（如 g203）上从 6403 fetch，然后用授权 key 通过 `ssh.github.com:443` push。本文档本身就是这样提交的。

## 3. 目录和关键入口

### 后端

- `backend/app.py`：FastAPI 组装入口。
- `backend/api/routes.py`：HTTP 和 WebSocket 路由入口。
- `backend/domain/models.py` / `schemas.py`：持久化模型和 camelCase API schema。
- `backend/adapters/config.py`：数据根、LTX23/H3 工作流模板、GPU 端口和 renderer 配置边界。数据根与两个模板路径现在都是默认值 + 环境变量覆盖，带存在性/可读性校验；GPU URL 和 unit allowlist 仍固定。
- `backend/adapters/database.py`：SQLite 初始化、WAL、外键、`busy_timeout=5000ms`。
- `backend/adapters/media.py`：ffprobe 60s、ffmpeg 300s 超时；调用经 `asyncio.to_thread` 离开事件循环。
- `backend/adapters/production_renderer.py`、`backend/services/job_executor.py`：生成提交、恢复、取消、结果持久化；executor 扫描循环对 claim 异常免疫。
- `backend/services/`：batches、catalog、samples、reviews、archives、statistics 等业务入口。
- `backend/tests/test_job_executor.py`：包含 claim 失败后循环存活、终态守卫等行为级测试（不再只是源码断言）。

### 前端

- `frontend/src/app/App.tsx`：路由入口（`/workspace`、`/generate/*`、`/review`、`/review/:sampleId`、`/archive`、`/settings`、`/me/statistics`）。
- `frontend/src/preferences.ts`：`useReviewerState`——从 localStorage 读取 `conflictstudio.reviewer.id/.name` 并用真实 Reviewer API 校验。
- `frontend/src/app/ReviewGate.tsx`：进入审核前的身份栏，可列出/新建/切换 reviewer 或以访客继续、可登出。
- `frontend/src/pages/ReviewListPage.tsx`、`ReviewDetailPage.tsx`：审核页。访客（reviewer 为 null）可浏览但控件禁用、textarea readOnly、备注自动保存守卫。
- `frontend/src/pages/SettingsPage.tsx`：reviewer 的完整管理（新建、选择、重命名）。
- `scripts/*.test.*`：前端静态/逻辑检查与源码断言，包括"frontend/src 中不得出现 `zhanghaonan` 字符串"的反硬编码测试。

## 4. 当前数据库事实（2026-08-24 实测）

以下数字来自本轮对规范 SQLite 的 Python `mode=ro` 只读查询（本轮重启前快照）：

| 对象 | 数量 | 说明 |
| --- | ---: | --- |
| reviewers | 1 | 存在真实审核员 |
| reviews | 4 | 有真实审核历史 |
| samples | 3 | |
| jobs / job_items | 8 / 8 | 全部 `Completed`（无 QUEUED/RUNNING 残留） |
| assets | 10 | |
| datasets | 1 | |
| scenes | 75 | |
| content_scripts | 104 | |
| archives / archive_items | 0 / 0 | 仍无归档记录 |

旧交接写的 reviewers=0、reviews=0、2 条 Pending、6 个任务已过期。

## 5. 从 `ca22050` 到本轮 HEAD 的全部提交（`ca22050..HEAD`，10 个）

1. `b1feac8 backend: keep job executor loop alive on claim failures` — executor 扫描循环对 claim 异常免疫。此前一次异常会永久杀死循环，任务永远停在 QUEUED。
2. `0d3b71f backend: bound media tooling with timeouts and offload from event loop` — ffprobe 60s / ffmpeg 300s 超时，media 调用经 `asyncio.to_thread` 下放。此前挂死的 ffmpeg 会冻结整个应用。
3. `89ab922 backend: tolerate sqlite contention during progress tracking` — busy_timeout 100ms→5s；进度事件每 item 限 1 次/2s；进度写遇到的 DatabaseBusyError 记录并跳过，不再让渲染失败。
4. `b86c165 backend: guard late item completion on terminal jobs` — 迟到的 item 完成不再改动终态任务的计数器和状态；提交失败只在没有任何兄弟 item 处于 RUNNING 时快速失败任务。
5. `bc6cd6b backend: make data root and workflow templates configurable` — 数据根 + LTX23 + H3 模板路径改为默认值 + env 覆盖，带存在性/可读性校验。此前 env 必须逐字等于硬编码绝对路径。GPU URL 和 unit allowlist 保持固定。
6. `7fcbef5 deploy: declare renderer unit conflicts on shared gpu slots` — 同槽位 renderer 单元两两互斥（对称 `Conflicts=`）；ltx/h3 单元移除 `[Install]`，只按需启动。
7. `2fc9623 frontend: resolve review identity from stored reviewer state` — 不再硬编码 reviewer；身份来自 localStorage 经 `useReviewerState`；访客 = null reviewer 并显示横幅。
8. `eefa29d review: enforce guest read-only in review pages` — 访客可浏览但不能选择/批量/决定/写备注（禁用控件、readOnly textarea、自动保存守卫）；note-draft ref 在 reviewerId 变化时也会重置。
9. `414fc9c frontend: add reviewer switcher to the review gate` — 审核门内的身份栏：列出/新建/切换 reviewer、登出；Settings 仍是完整管理入口。
10. 本提交 — `docs: refresh next session handoff`（即本文档）。

## 6. 当前部署拓扑

```text
浏览器
  -> g203 0.0.0.0:8890
  -> conflictstudio-prototype-nginx.service
  -> g203 127.0.0.1:18003
  -> conflictstudio-preview-forward.service 的 SSH -L
  -> 6403 127.0.0.1:8001
  -> conflictstudio-preview.service
  -> /home/team/zhanghaonan/ConflictStudio
  -> /home/team/zhanghaonan/ConflictStudio-data
```

这条链路本轮已确认工作：`/api/health` 经 8890 返回 ok。

关于 systemd 单元要分清楚两个事实：

- **正在运行的是 `conflictstudio-preview.service`（用户单元，监听 127.0.0.1:8001）。** 这是当前 live 单元。
- 仓库里同时存在 `deploy/systemd/conflictstudio.service`（端口同样来自其 env：`CONFLICTSTUDIO_PORT=8001`）。它在仓库中保留，但不是当前 live 单元。改部署配置时改仓库文件后要同步到 preview 单元对应的实际 unit 文件，不要误以为改了仓库文件就等于改了运行单元。
- renderer 单元（ltx / h3 / ltx25，各 GPU 槽两个）是按需启动的，当前都没有运行，GPU 空闲。同槽位单元有对称 `Conflicts=`，启动一个会阻止另一个。
- g203 的 8888 是旧系统，不属于本仓库范围，不要动。
- 6403 旧的 `conflictstudio-preview-tunnel.service` 保持 disabled/dead，不要重新启用。

## 7. 测试覆盖的真实情况

- 后端 `backend/tests/` 覆盖服务契约，并且本轮新增了行为级测试：claim 失败后循环存活（`test_job_executor.py::test_run_loop_survives_claim_failure`）、SQLite busy 容忍、媒体超时。这些是真实行为测试，不再只是源码正则断言。
- 前端有反硬编码测试：`frontend/src` 中出现 `zhanghaonan` 字符串会失败。
- 仍然没有被证明的：生成管线没有端到端 GPU 测试。后端测试用假 renderer，不证明 ComfyUI、真实 GPU、systemd renderer 链路可用。本轮 10 个提交之后服务尚未做过完整的重启 + 真实生成回归。
- 浏览器级验收（真实 8890 页面上的完整用户流程）本轮没有重新执行。

## 8. 旧"已知问题"清单的处置

1. **审核页三态操作** — 已被提交 7-9 取代。现在详情页有 Accepted / Rejected / Pending（withdraw）三个操作；身份从真实 Reviewer API 校验。不再列为未完成。
2. **reviewer 状态修复没有覆盖审核列表** — 已取代。审核列表与详情统一使用存储并校验的 reviewer 状态。
3. **设置姓名流程** — 已取代。没有强制的名字；创建/切换在审核门内联可用，完整管理在 Settings。
4. **生成卡死修复只有静态断言** — 部分解决。提交 1-3 加了真实行为测试（循环存活、busy 容忍、超时），比源码断言强得多。但要直说：生成管线仍然没有端到端 GPU 测试，"卡死已根治"只能建立在行为测试 + 下一次真实生成回归之上。
5. **归档和统计缺少可验收数据** — 仍然开放。archives=0、archive_items=0。审核数据已经有了（1 reviewer、4 reviews），但归档同步和 manifest 主流程仍无可验收数据。

其他仍然成立的事实：`conflictstudio-preview-tunnel.service` 不要启用；不复制第二套环境；不输出密钥。

## 9. 下一会话的有限执行清单

严格按顺序，一次只做一项。

### 1. 重启后的服务健康与回归

1. 重启 `conflictstudio-preview.service`（本轮 10 个提交的代码尚未在重启后验证）。
2. 经 8890 打开 `/api/health` 确认 ok；打开 `/review` 确认身份栏、访客只读、真实 reviewer 下的三态操作可见。
3. 观察日志确认 executor 循环存活、无 busy 报错刷屏。

### 2. 真实生成回归（需用户授权 GPU 与数据写入）

1. 启动一个 renderer 单元，验证 Conflicts= 生效（同槽另一个不能同时启动）。
2. 提交一个小规模真实任务，验证 job / job_item / event / asset / sample 链路和进度事件限速行为。
3. 完成后关掉 renderer，释放 GPU。

停止条件：真实 API 不匹配、GPU 所有权不清楚、需要换模型/端口/批量参数时立即停，不降配置、不换 GPU、不加 fallback。

### 3. 归档与统计闭环

1. 有了真实审核结果后，`/archive` 预览同步与数据库对照；获授权后执行 sync，验证 archive / archive_items / manifest。
2. `/me/statistics` 用真实 reviewer 对照 SQLite 逐项核数。

## 10. 禁止事项

- 不复制 `/home/team/zhanghaonan/ConflictStudio`，不建第二个 worktree、部署副本或数据副本。
- 不修改、重启、替换或占用 8888。
- 不重新启用 `conflictstudio-preview-tunnel.service`；链路只用 g203 的 forward service。
- 不使用 mock、fixture、fallback renderer、备用模型、备用端口、hash 内容或本地后处理冒充真实功能。
- 不静默降低 batch、改种子、换 GPU、换精度、重复任务或加入降级路径。
- 不把 API 200、pytest 通过、TypeScript/build 通过或按钮 enabled 当作 UI 完成。
- 不把类别转换当作独立"待审核"操作，除非先有明确的产品语义和后端契约。
- 不输出、复制或提交 `ConflictStudio.env` 中的密钥。
- 不直接在 6403 上 push GitHub（网络不通）；按第 2 节的中继流程推送。

## 11. 本轮交接完成检查

- 基线：`master`，`ca22050..HEAD` 共 10 个提交（9 个业务 + 本 docs 提交），提交前工作树干净。
- 已实测核对：SQLite 计数（read-only）、deploy 单元文件（Conflicts=、无 [Install]、preview vs 仓库单元）、config.py 可配置项、media 超时、busy_timeout=5000、前端 reviewer 状态与访客只读、反硬编码测试、行为级 executor 测试。
- 已确认拓扑：浏览器 → 8890 → 18003 → 6403:8001 健康 ok；renderer 单元按需未运行。
- 已明确：生成管线缺端到端 GPU 测试；归档无数据；本轮代码尚未在重启后回归。
- 本轮唯一 Git 变化：`docs/NEXT_SESSION_HANDOFF.md`。

## 2026-08-24 bug-fix session (by lvshuyang's assistant, commits 2f8d86b / ca4695f / 75333fc)

Fixed, all gates green (backend pytest 522 passed, npm run check passed),
verified end to end on 8890 after restarting conflictstudio-preview:

1. Prompt generation now retries content-level failures up to 3 times,
   feeding the validator errors back to DeepSeek. Before this, some
   generative content scripts failed 100% of the time with 502
   invalid_prompt_schema because the model exceeded the bodyAction /
   vocalDelivery word budgets. Transport/auth errors still fail fast.
2. /api/prompt-templates supports ?category=, template versions support
   ?verificationStatus=, /api/samples supports ?inArchive=, and
   /api/jobs/{id}/events supports ?order=desc. The frontend now uses
   these instead of client-side filtering, which fixes: template
   dropdown pagination mismatch (page total showed the unfiltered
   count), templates on later pages being unselectable, archive page
   pagination missing archived samples beyond server page 1, and the
   workspace pending-archive metric counting already-archived samples.
3. Review flow: after a 409 revision conflict the related queries are
   invalidated so retrying works without a full page reload; the note
   draft re-syncs from the server after a conflict.
4. Review list search is debounced (was one navigation + request per
   keystroke, clearing the batch selection each time). Archive page
   search is debounced and server-side.
5. MediaPanel sets video src directly; swapping a <source> child never
   reloads the video (job item retries / WS updates kept showing the
   old clip in ResultsOutputList).
6. Stage changes render newest-first (order=desc) and collapse keeps
   the latest progress event; completion events are visible without
   paging. Prompt schema error toasts now include the field reasons.
7. Small fixes: template options show the template name; the
   unselectable empty option only renders when a list is empty; the
   production submit dialog no longer shows an empty dataset name; the
   unsaved-changes dialog has a distinct title; emotion labels outside
   the vocabulary fall back to the raw value; frontend emotion equality
   is case-insensitive like the backend.

Known items intentionally NOT touched (for the owner to decide):
- deploy/nginx/conflictstudio.conf (the OLD 8888-prototype config) has been
  deleted from the repo; the real 8890 nginx config lives on the g203 machine
  (~/.config/nginx/) and is not part of this repository.
- The live sqlite still contains dropped tables configuration_assistants
  and generation_test_drafts (create_all never drops); tests assert they
  must not exist on fresh databases.
- The H3 workflow template path points into
  H3-ComfyUI/output/compare-vt-va-20260806/...; anything cleaning that
  output directory breaks the H3 renderer. Consider moving it into
  backend/resources/workflows/.
- Dead code noticed: useJobAttemptsQuery, useReleaseGpuMutation + gpu
  release strings, latestCachedJobEventId (no callers).
- queryKeys.job/jobItems do not encode test vs production; manual URL
  edits of tab= can serve cached data from the other endpoint.

## 2026-08-25 full-repo review + fix round (commits 36b9883..d31d042, 9 个)

Fresh full review (backend + frontend + browser-measured layout) followed by
fixes; every commit individually green (backend pytest 525 passed; repo-root
npm run check passed), service restarted, end-to-end verified on 8890:

1. `36b9883` renderer output directories now derive from the configured
   data root (Settings single source of truth). gpu.py no longer hardcodes
   ConflictStudio-data; env override now actually flows to systemd
   --output-directory. Default deployment byte-identical (unit token tests
   against the live unit files still pass).
2. `6b20686` gpu slot subprocess calls (systemctl/nvidia-smi/ss) bounded
   with a 30s timeout; a hung nvidia-smi can no longer hang /api/health.
3. `8375b1c` run.sh exports the CONFLICTSTUDIO_DATA_ROOT fallback to
   uvicorn (set +a was cutting it off).
4. `aaa55a8` stale prototype nginx config deleted (see "Known items"
   above); integrate.sh deploy:check no longer greps it.
5. `3afee8e` app-wide React ErrorBoundary (was: any render error =
   unstyled white screen), fallback reuses state-view error styles with a
   return-to-workspace button; copy in both locales.
6. `b310a38` review list search debounce no longer captures a stale
   locationState (filters changed inside the debounce window used to be
   reverted by the delayed navigation).
7. `7cb140d` .button--danger finally has CSS (red border/text); used by
   the dataset delete action (only rendered for Inactive datasets).
8. `a5bbf65` + `d31d042` review gate banner actions vertically centered
   (align-items baseline -> center, plus resetting the <p> UA bottom
   margin that offset the text 7px). Verified by measurement: all banner
   children now share center=99px at 1280x800.

Layout QA (all 11 routes, desktop 1280x800 + mobile 375x812, guest and
signed-in states): zero console errors, zero horizontal overflow, zero
real element overlap (4 apparent overlaps were closed <details> panels,
not painted). CSS var audit: used-vs-defined diff empty both ways.

## 2026-08-25 third review round (commits 287b578..9df07f2 + be7d451, 12 个)

Third full pass (backend deep-read + frontend deep-read + API contract
cross-check). All gates green per commit (backend pytest 524; repo-root
npm run check); service restarted and verified on 8890:

1. `287b578` configured paths (data root + both workflow templates) are
   now resolved in Settings.from_environment before unit definitions are
   built — env paths with symlinks or ".." no longer fail the allowlist
   assertion at startup (symlink test added).
2. `6b9343e` run.sh validates data paths after cd into project root.
3. `cfe3f10` the post-kill drain of gpu subprocess pipes is bounded (5s)
   — a D-state nvidia-smi can no longer hang the executor coroutine.
4. `c65e436` seven frontend-unused API routes deleted (prompt-preview,
   dataset merge, content-scripts/scenes DELETE, prompt-templates
   POST/PATCH, classification-history) plus their orphaned services and
   schemas. NOTE: GET /api/archives/{id}/manifest was kept — ArchivePage
   downloads it via <a href>, outside the query layer.
5. `14dbb01` + `be7d451` review table scrolls with a 720px min width in
   the 721-768px band (media block must come after the base rule —
   same-specificity cascade).
6. `21574dd` gpuCodes now maps the codes the backend actually emits
   (gpu_slot_unavailable / gpu_state_unavailable / model_service_changed).
7. `b1b9469` archive_preview_stale joins reloadCodes; ArchivePage drops
   the stale local preview on conflict instead of retrying into 409.
8. `fdf97be` detail disclosure/history panels reset across samples
   (key={sample.id} on both <details>).
9. `46fc638` switching reviewer in the detail banner flushes the pending
   note under the OLD reviewer id before resetting the draft.
10. `678440f` ErrorBoundary now wraps AppShell (topbar/shell crashes get
    the fallback UI too).
11. `9df07f2` pagination is disabled while the search debounce settles
    (new optional `disabled` prop on Pagination).

Browser-verified after deploy: 744px band (table 720px + h-scroll),
desktop status-cell centering intact, disclosure closes on next-sample
navigation, pagination disables during debounce, zero console errors.
Not live-tested (logic-verified only): error-boundary fallback render,
note flush on switch, gpu/archive error-code paths.
