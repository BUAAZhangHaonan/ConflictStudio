# ConflictStudio 新会话交接

审计日期：2026 年 8 月 23 日

审计对象：6403 上的唯一规范仓库 `/home/team/zhanghaonan/ConflictStudio`

审计方式：只读检查 Git、源代码、SQLite、systemd 用户单元、监听端口和健康接口。没有修改业务代码、业务数据、服务或 8888。按用户最后指令，本轮没有再运行 npm、pytest 或 Playwright。

## 1. 项目目标与边界

ConflictStudio 是一个本地全栈工具。它负责组织生成配置、提交视频生成任务、查看结果、审核正式样本、同步归档和查看审核统计。

边界必须保持清楚：

- 测试任务和正式生成是两条数据链。`PromptTest` 和 `VideoTest` 不能产生正式样本，也不能进入审核或归档。只有 `Production` 完成项可以产生 `samples`。
- 前端只能调用本仓库 FastAPI 提供的接口。模型、工作流、端口和凭据由服务端固定配置。不要让浏览器提交任意 endpoint、model、workflow 或 key。
- 审核历史是追加记录。不要覆盖旧审核。类别转换和“待审核”不是同一件事，不能用改分类假装实现“待审核”。
- 归档以正式数据集为单位。当前数据库没有归档记录，也没有归档条目。
- 8888 是旧系统的保护边界，不属于本仓库。本项目入口是 8890。不要重启、替换、代理或探测性修改 8888。
- 本轮只把当前事实写入本文档。旧交接中的“全部完成”“没有遗留 P0”“Playwright 已覆盖”等乐观结论不能继续沿用。

## 2. 唯一代码、数据和配置位置

| 项目 | 当前事实 |
| --- | --- |
| 代码仓库 | `/home/team/zhanghaonan/ConflictStudio` |
| Git 工作树 | `git worktree list` 只列出 `/home/team/zhanghaonan/ConflictStudio` |
| 数据根目录 | `/home/team/zhanghaonan/ConflictStudio-data` |
| SQLite | `/home/team/zhanghaonan/ConflictStudio-data/database/conflictstudio.sqlite3` |
| 运行配置 | `/home/team/zhanghaonan/ConflictStudio/ConflictStudio.env`，不提交，不输出密钥 |
| remote | `origin git@github.com:BUAAZhangHaonan/ConflictStudio.git`，fetch/push 相同 |
| branch | `master`，审计开始时为 `master...origin/master` |
| 业务审计基线 HEAD | `13c1acdd0da6c9e6079bbfd1fc10f039dc3eef66` |

`13c1acd` 是写本文档前的业务代码 HEAD，也是本文档提交的父提交。本文档会形成一个单独的 docs commit，所以提交后仓库 HEAD 会前进一次；不要把 docs commit 误认为新的业务功能版本。

不要复制仓库、数据目录或配置文件来做第二套运行环境。也不要恢复已经删除的 TAFFC 下旧 ConflictStudio、旧部署副本或旧数据目录。本轮没有做全盘 `find`，因此这里只确认规范路径和 Git 工作树事实，不重复旧交接中“全盘副本数量为 0”的结论。

## 3. 目录和关键入口

### 后端

- `backend/app.py`：FastAPI 组装入口。创建数据库、提示词模型、渲染网关、各业务 service，并挂载 API、WebSocket、媒体和前端静态文件。
- `backend/api/routes.py`：HTTP 和 WebSocket 路由入口。
- `backend/domain/models.py`：SQLite/SQLModel 表、约束和核心持久化模型。
- `backend/domain/schemas.py`：请求与响应模型，统一 camelCase API 字段。
- `backend/adapters/config.py`：固定数据根、工作流路径、GPU 端口和 renderer 配置边界。
- `backend/adapters/database.py`：SQLite 初始化、WAL、外键、不可变记录和业务触发器。
- `backend/adapters/production_renderer.py`、`backend/services/job_executor.py`：真实生成提交、恢复、取消、结果持久化和事件处理。
- `backend/services/batches.py`、`catalog.py`、`samples.py`、`reviews.py`、`archives.py`、`statistics.py`：正式生成、目录资源、样本、审核、归档和统计的主要业务入口。
- `backend/tests/`：后端契约和服务测试。大部分使用临时数据根、假模型或假 renderer，不是当前部署的浏览器验收。

### 前端

- `frontend/src/main.tsx`：React 启动入口。
- `frontend/src/app/App.tsx`：路由入口。当前路由为 `/workspace`、`/generate/test`、`/generate/production`、`/generate/results`、`/review`、`/review/:sampleId`、`/archive`、`/settings`、`/me/statistics`。
- `frontend/src/api/client.ts`、`contracts.ts`、`queries.ts`：真实 API client、类型和 React Query hooks。
- `frontend/src/preferences.ts`：语言和当前 reviewer 的浏览器状态；`useReviewerState` 会用真实 Reviewer API 校验 localStorage 中的 ID。
- `frontend/src/pages/generate/TestPage.tsx`、`ProductionPage.tsx`、`ResultsView.tsx`：测试、正式生成和结果页。
- `frontend/src/pages/ReviewListPage.tsx`、`ReviewDetailPage.tsx`：审核列表和详情页。
- `frontend/src/pages/ArchivePage.tsx`、`SettingsPage.tsx`、`StatisticsPage.tsx`：归档、设置和个人统计页。
- `frontend/src/locales/`：中英文文案。
- `scripts/*.test.*`：前端静态/逻辑检查；`scripts/browser-check.mjs` 和 `scripts/review-browser-check.mjs` 是基于 fixture API 的浏览器脚本。

## 4. 当前数据库事实

以下数字来自对规范 SQLite 的 `sqlite3 -readonly` 查询。完整性检查返回 `ok`，journal mode 为 `wal`，外键检查没有输出异常行。

| 对象 | 数量 | 当前内容 |
| --- | ---: | --- |
| 数据集 `datasets` | 1 | `id=1`，名称“正式样本”，`Formal`，`Active` |
| 样本 `samples` | 2 | `CS-000001` 为 `A-VA`，`CS-000002` 为 `C-VT`；两条都是 `Pending`，`review_revision=0` |
| 审核员 `reviewers` | 0 | 当前没有任何可选审核员 |
| 审核 `reviews` | 0 | 当前没有任何审核历史 |
| 任务 `jobs` | 6 | 2 个 `Production`、1 个 `PromptTest`、3 个 `VideoTest`；全部 `Completed` |
| 任务项 `job_items` | 6 | 每个任务 1 项，全部 `Completed` |
| 资产 `assets` | 9 | 正式生成 3 个，视频测试 6 个 |
| 归档 `archives` | 0 | 当前没有 manifest 状态记录 |
| 归档条目 `archive_items` | 0 | 当前没有已归档样本 |

资产细分：正式生成有 2 个有声资产和 1 个静音资产；视频测试有 3 个有声资产和 3 个静音资产。两条正式样本都由 LTX-2.5 生成，分别记录在 GPU0 和 GPU1。数据库中没有审核备注草稿，也没有类别转换记录。

## 5. 五类页面当前真实状态

这里区分“代码已经接真实 API”和“当前用户现在能完成”。没有经过本轮真实浏览器点击的功能不能写成已验收。

### 生成

- `/generate/test` 接真实内容、场景、模板、模板版本、GPU、测试提交和结果接口。页面支持 Prompt Test 和 Video Test；Prompt Test 不选 GPU，Video Test 选择一个 GPU；最多放两组对比配置。最近测试可以打开结果页或只在本地隐藏。
- `/generate/production` 接真实数据集、内容、模板、GPU、草稿保存、任务预览和正式提交接口。页面按数据集、内容与场景、人物与种子、模型与 GPU 组织配置，保存草稿后才可预览，预览未变更时才可提交。
- `/generate/results` 区分测试和正式任务，支持分页、筛选、任务详情、任务项、持久事件、取消、恢复和失败项重试。当前库里能看到 6 个已完成任务和 9 个资产。
- 本轮没有提交 DeepSeek 或视频任务，没有启动 renderer，也没有重新验收三个生成页面。

### 审核

- `/review` 使用真实样本列表 API。筛选状态保存在 URL，包含搜索、数据集、审核状态、协议、关系、冲突方向和页码。当前应有 2 条待审核样本。
- `/review/:sampleId` 使用真实详情、备注草稿、审核提交和类别转换 API。代码支持主媒体/源媒体切换、备注自动保存、通过、淘汰和类别转换。
- 当前数据库没有 reviewer。详情页的 `canReview` 为 false，页面进入只读状态，并把整个操作区隐藏。用户当前看不到一组可用的“通过、淘汰、待审核”三个操作。
- 即使存在 reviewer，详情页当前也只有 `Accepted`、`Rejected` 和“类别转换”三个按钮。没有独立的 `Pending` 操作。后端现有审核接口也把 `Pending` 当作非法审核决定；不能把“类别转换后回到 Pending”偷换成普通“待审核”操作。
- 列表页批量决定只有通过和淘汰，没有待审核。并且列表页仍直接使用 `usePreferences().currentReviewerId`，没有使用本次新增的 `useReviewerState`；一个残留 localStorage ID 可能让列表控件看起来可写，但真实 reviewer 已不存在。这一处也必须随审核页一起收口。

### 归档

- `/archive` 接真实数据集、审核样本、归档状态、预览同步、执行同步和 manifest 下载接口。它支持按数据集预览新增、更新、移除和不变项，确认后同步，并从归档列表返回审核详情。
- 当前 `archives=0`、`archive_items=0`，两条样本又都是 Pending，所以当前页面没有可证明的已归档内容。本轮没有执行预览同步或写 manifest。

### 设置

- `/settings` 接真实 reviewer、健康、数据集和 GPU 接口。页面可以新建、选择和重命名 reviewer，切换中英文，并重新读取服务状态。
- 当前 reviewer 总数为 0，因此真实状态是“没有当前审核员，也没有可选审核员”。页面提供新建姓名表单，但本轮没有创建姓名。
- `2173ab0` 新增的 `useReviewerState` 会校验 localStorage ID：先查当前 reviewer 分页；如果 ID 不在当前页，再查单个 reviewer；真实 API 返回 404 时清除旧 ID。这个修复已接入首次 reviewer 对话框、审核详情、设置和统计，但没有接入审核列表。

### 统计

- `/me/statistics` 接真实 reviewer 统计接口。存在有效 reviewer 时，页面支持数据集搜索/选择、起止日期、审核总数、通过/淘汰、VA/VT、修订样本、归档状态和每日活动。
- 当前 reviewer 和 review 都是 0，所以统计页只能显示空状态并引导到设置页。现在没有任何真实个人统计可供验收。
- 页面会在 reviewer 404 时清除旧 localStorage ID。这个行为来自 `2173ab0`，但本轮没有用真实浏览器重新点击验证。

## 6. 从 `8ecccd8` 到业务审计基线的全部新提交

范围是 `8ecccd8..13c1acdd0da6c9e6079bbfd1fc10f039dc3eef66`，共 3 个提交。

### `462551abe308d693fc2c626b64377a17361ae6b0` — `fix(frontend): stop empty-scene render loop`

根因：`TestPage` 原来写成 `scenesQuery.data?.scenes ?? []`。当场景请求还没有数据或返回空列表时，每次 render 都创建一个新的空数组。选择场景的 effect 依赖这个数组，又反复把 `sceneId` 写成 `null`，但每次都创建新的 form 对象，于是 render 和 effect 持续互相触发，测试生成页表现为卡死。

改动：

- 增加稳定的模块级 `EMPTY_SCENES`。
- 用 `selectedSceneExists` 和 `firstSceneId` 作为稳定依赖。
- 在目标 `sceneId` 已经相同时返回原 state，不再制造无效更新。
- 增加源码断言测试，防止重新写回内联 `[]` 或无条件更新。

文件：

- `frontend/src/pages/generate/TestPage.tsx`
- `scripts/test-workflow.test.mjs`

这个提交解释了卡死根因并修了代码，但新增测试是源码模式检查，不是真实浏览器回归。新会话仍要逐页重新审查测试、正式生成和结果页，不能因该提交存在就写“生成完成”。

### `2173ab0d868e34c2e7a80097e8cabeee200397c8` — `fix(frontend): validate reviewer selection`

改动：

- `useReviewerQuery` 增加明确的 enabled 条件。
- 在 `preferences.ts` 增加统一 `useReviewerState`，用 Reviewer API 校验 ID、同步真实姓名、处理跨分页 reviewer，并在 404 时清掉残留选择。
- 首次 reviewer 对话框不再把 localStorage 姓名当成真实 reviewer。
- 审核详情、设置和统计改用已校验 reviewer。
- 详情只在 reviewer 有效时显示写操作，并为只读状态增加设置入口。
- 设置页补充 reviewer 空状态和统一重试。
- 统计页补充 reviewer 加载、错误、404 清理和重试。

文件：

- `frontend/src/api/queries.ts`
- `frontend/src/app/FirstReviewerDialog.tsx`
- `frontend/src/pages/ReviewDetailPage.tsx`
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/pages/StatisticsPage.tsx`
- `frontend/src/preferences.ts`

### `13c1acdd0da6c9e6079bbfd1fc10f039dc3eef66` — `test: align reviewer state assertions`

改动：只调整前端源码断言和 preferences 测试桩，使它们匹配 `useReviewerState`、404 清理和统一重试。没有业务运行时代码变化。

文件：

- `scripts/api-wiring.test.mjs`
- `scripts/preferences.test.mts`

## 7. 当前部署拓扑

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

审计时的具体状态：

- 6403：`conflictstudio-preview.service` 为 enabled、active、running，工作目录是规范仓库，主进程监听 `127.0.0.1:8001`。`/api/health` 返回 200，数据库 ready、prompt service configured、renderer installation installed。
- g203：`conflictstudio-preview-forward.service` 为 enabled、active、running。它从 g203 建立 `-L 127.0.0.1:18003:127.0.0.1:8001` 到 6403。`127.0.0.1:18003` 由该 SSH 进程监听。
- g203：`conflictstudio-prototype-nginx.service` 为 enabled、active、running，监听 `0.0.0.0:8890`，Nginx 把请求、Range 和 WebSocket upgrade 代理到 `127.0.0.1:18003`。
- 6403 上旧的反向隧道 `conflictstudio-preview-tunnel.service` 仍有 unit 文件，但状态是 disabled、inactive、dead。不要重新启用。现在只使用 g203 主动连 6403 的 forward service。
- g203 的 8888 仍由独立 Python 进程监听，本轮只读探测 HTTP 为 200。它是旧系统，不在 ConflictStudio 的启动、部署、测试或清理范围内。本轮没有操作 8888。
- 8890 服务名仍带 `prototype`，这只是现有 unit 名称。不要为改名而重建部署，也不要引入第二个仓库或第二套数据。

## 8. 自动测试和浏览器测试的真实覆盖

### 自动测试能证明什么

- 后端 `backend/tests/` 覆盖数据库约束、目录资源、生成任务、恢复/取消/重试、媒体、审核追加记录、类别转换、备注草稿、归档、统计、GPU unit allowlist、分页和 WebSocket 等服务契约。
- 根目录 `npm run check` 当前依次运行 `test:time`、`test:review-archive`、`test:copy`、`test:api`、`test:test-workflow`、`test:results`、`test:preferences`、TypeScript、Vite build、文案检查和构建产物检查。
- `462551a` 的防卡死回归和 `13c1acd` 的 reviewer 回归主要是读取源码后做正则断言。它们能防止特定代码形状退回，不能证明页面真的可操作。

### 自动测试没有证明什么

- `npm run check` 不运行 `scripts/review-detail.test.mts`、`scripts/review-list.test.mts`、`browser:check` 或 `browser:review`。
- 后端测试使用临时数据库、假模型或假 renderer，不会证明 6403 当前数据、DeepSeek、ComfyUI、GPU 或 systemd 链路可用。
- TypeScript、build、静态源码断言和 API 200 都不能证明用户能看见按钮、完成表单、返回列表、保存审核或在小屏操作。
- 旧交接写的“后端 500 项通过”没有在本轮重新运行，不能作为当前 HEAD 的新证据。

### 浏览器脚本能证明什么

- `scripts/browser-check.mjs` 和 `scripts/review-browser-check.mjs` 都启动本地 Vite，并安装 `createBrowserApiFixture()`；前者还替换 WebSocket。它们测试的是前端在固定 fixture 下的路由、布局、分页、对话框、部分请求和中英文，不是 8890 的真实 API、真实 SQLite 或真实服务。
- `review-browser-check.mjs` 的 fixture 流程覆盖列表到详情再返回、媒体切换、备注保存、一次 Accepted 提交、归档返回路径，以及 1440/1024/768/390 的中英文无横向溢出。

### 当前最重要的浏览器证据缺口

上一轮针对真实页面的 Playwright 验收只做了以下事情：临时创建一个 reviewer，确认“已通过”和“淘汰”两个按钮为 enabled，然后删除该 reviewer。当前数据库 `reviewers=0`、`reviews=0`。因此，这个验收不能证明普通用户从当前空 reviewer 状态出发能完成审核。“待审核”操作从未验证，而且当前详情页根本没有独立的 Pending 按钮。

本轮按用户最后指令没有再运行 Playwright。不要把 fixture 浏览器脚本、上一轮临时 reviewer 检查或 API 200 合并成“审核 UI 已完成”。

## 9. 最高优先级已知问题

1. **审核页三态操作未完成。** 用户当前看到的审核详情没有可见的“通过、淘汰、待审核”三个操作。没有 reviewer 时，整组操作被隐藏；有 reviewer 时也只有通过、淘汰、类别转换，没有独立待审核。上一轮 Playwright 只证明临时 reviewer 下前两个按钮 enabled，随后 reviewer 被删除，Pending 从未测试。这是下一会话第一优先级，不能再写成已验收。
2. **reviewer 状态修复没有覆盖审核列表。** 设置、统计、首次对话框和审核详情使用 `useReviewerState`，但审核列表仍信任 localStorage ID。必须统一，否则列表可能显示可写、详情却只读，或提交一个数据库中不存在的 reviewer ID。
3. **设置姓名流程没有真实完成。** 当前 reviewer 为 0。创建、选中、刷新、跨路由、重命名、清理失效 ID 和统计读取必须用普通用户路径一起验收。只调用 Reviewer API 或临时创建后删除不算完成。
4. **生成卡死修复只有代码和静态断言。** 根因和提交已经明确，但测试页、正式生成页、结果页仍需新会话逐页重审。不得把无 render loop 等同于生成工作流完成。
5. **归档和统计缺少可验收数据。** 当前没有审核、reviewer、archive 或 archive item。空状态可以观察，但不能证明同步、manifest 和个人统计主流程。

## 10. 下一会话的有限执行清单

严格按下面顺序做。一次只处理这一页的当前问题。前一步达到停止条件时就停，不要用 mock、fallback 或换参数绕过。

### 1. 审核页：先完成三态操作

验收动作：

1. 先读后端审核契约，明确“待审核”是把已有审核结论重置为 Pending，还是另一种业务动作。现有 POST review 不接受 Pending，不能只在前端加一个假按钮，也不能默认用类别转换代替。
2. 统一 `/review` 和 `/review/:sampleId` 的 reviewer 状态，都使用真实 Reviewer API 校验后的 ID。
3. 在真实页面上让“通过、淘汰、待审核”三个操作都可见，并为每个操作显示清楚的确认和结果。只读用户要看到原因和进入设置的明确入口。
4. 用全新浏览器上下文检查 `/review`、直接打开 `/review/1`、详情返回、URL 筛选和滚动恢复。
5. 在获得对正式样本写审核历史的明确授权后，选定一条真实样本，分别验证三态请求、数据库结果、刷新后的状态和下一条导航。验证 Pending 时必须检查真实数据库，不看按钮文字就结束。

停止条件：如果 Pending 的业务语义或后端契约仍不明确，立即停在契约层，不写 UI 假实现；如果没有获准修改当前两条正式样本，不执行审核写入，也不声称端到端通过；如果只能让按钮 enabled、只能得到 API 200、或只能在 fixture 中通过，也不能进入“完成”。

### 2. 设置页：完成姓名流程，再回到审核页闭环

验收动作：

1. 从当前 `reviewers=0` 的真实状态开始，通过 `/settings` 的普通表单创建用户确认的真实姓名。不要创建随后删除的临时姓名来代替验收。
2. 检查设置页显示当前 reviewer，刷新后仍能通过真实 API 恢复；直接打开审核详情和统计页时也使用同一个有效 ID 和最新姓名。
3. 通过 UI 重命名，检查 SQLite 记录、localStorage 显示和跨页面姓名一致。
4. 人为放入一个不存在的 ID 只可在隔离浏览器 localStorage 中做，不改数据库；检查设置、详情、统计和审核列表都清理失效选择并回到明确空状态。
5. 回到审核页，按第一步的普通用户路径完成三态最终验收。临时 reviewer 检查不能替代这一闭环。

停止条件：没有用户确认的持久 reviewer 姓名时，不往规范数据库写占位姓名；任何页面仍信任失效 ID、姓名不同步或刷新后丢失时，停止并修该共同状态，不继续生成页。

### 3. 生成页：按测试、正式生成、结果逐页重审

验收动作：

1. 用 8890 真实页面直接打开 `/generate/test`，等待场景为空、加载中和有数据三种状态，确认没有持续 render、页面卡死或控制台错误。
2. 检查 Prompt Test 与 Video Test 切换、内容/场景/模板/版本选择、最多两组对比、校验、确认对话框和结果跳转。
3. 打开 `/generate/production`，检查真实数据集、内容跨页选择、模板版本、人物、种子、模型、精度、GPU、保存草稿、预览和未保存变更限制。
4. 打开 `/generate/results`，检查测试/正式筛选、6 个现有任务、任务项、事件、媒体和返回测试草稿。取消、恢复和重试只对满足真实状态的任务验证。
5. 只有用户明确授权真实 DeepSeek、GPU 和数据写入时，才提交新的 Prompt Test、Video Test 或 Production；提交后检查 job、job_item、event、asset 和 sample 的真实边界。

停止条件：任何页面再次卡死、真实 API 返回不匹配、GPU 所有权不清楚或需要换模型/端口/批量参数时立即停；不要降低配置、换 GPU、启动 fallback、使用 mock 视频或重复提交。

### 4. 最后检查归档和统计

验收动作：

1. 在有真实审核结果后打开 `/archive`，检查当前/待更新计数和 preview 的 added/updated/removed/unchanged 与数据库一致。
2. 只有得到归档写入授权后才执行 sync；随后检查 archive、archive_items、manifest 下载、媒体路径和从归档返回详情。
3. 用第二步创建并保留的真实 reviewer 打开 `/me/statistics`，检查默认 30 天、数据集筛选、日期范围、通过/淘汰、VA/VT、修订和归档计数，并与 SQLite 查询逐项对照。
4. 最后再做中文/英文和 1440/1024/768/390 的真实 8890 浏览器检查。记录真实请求、可见结果和未覆盖项。

停止条件：没有真实审核或归档数据时，只能确认空状态，不能用 fixture 填满页面；未获准写 manifest 时停在 preview；统计数字与数据库不一致时停止，不用前端重算、hash 或后处理遮盖。

## 11. 禁止事项

- 不复制 `/home/team/zhanghaonan/ConflictStudio`，不建立第二个 worktree、部署副本或数据副本。
- 不修改、重启、替换或占用 8888；不把 8890 的问题转嫁给 8888。
- 不重新启用 `conflictstudio-preview-tunnel.service`；当前链路只用 g203 的 `conflictstudio-preview-forward.service`。
- 不使用 mock、fixture 数据、mockMedia、fallback renderer、备用模型、备用端口、hash 生成内容或本地后处理来冒充真实功能。
- 不静默降低 batch、改种子、换 GPU、换精度、重复任务或加入降级路径。
- 不把 API 200、pytest 通过、TypeScript 通过、Vite build 通过、源码正则断言或按钮 enabled 当作 UI 完成。
- 不把临时创建后删除 reviewer 的 Playwright 结果当作普通用户验收。
- 不把类别转换当作独立“待审核”操作，除非先有明确的产品语义和后端契约。
- 不输出、复制或提交 `ConflictStudio.env` 中的密钥。
- 不沿用旧交接的完成结论。每一页都要用当前仓库、当前服务、当前数据库和真实浏览器重新得出结论。

## 12. 本轮交接完成检查

- 审计基线：`master`、`13c1acdd0da6c9e6079bbfd1fc10f039dc3eef66`、工作树起始干净。
- 已核对：规范路径、remote、branch、Git 提交范围、关键模块、SQLite 数量、服务单元、端口和 forward/reverse 方向。
- 已明确：当前审核主流程没有完成；生成卡死修复需要浏览器复验；设置和统计当前受 reviewer 空数据限制；归档没有真实记录。
- 未执行：npm、pytest、新 Playwright、真实审核写入、生成任务、归档同步、服务重启和 8888 操作。
- 本轮唯一预期 Git 变化：`docs/NEXT_SESSION_HANDOFF.md`。
