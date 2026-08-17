# ConflictStudio 下一会话交接

本文件记录 2026 年 8 月 17 日的已批准边界、实现基线、未完成工作、部署审计和后续验收标准。下一会话只能以本文件和现场只读复核为起点，不能把历史部署状态当成当前状态。

当前并行执行状态：全部子代理均已关闭，没有仍在运行的子代理。

## 1. 已批准边界

### 1.1 路径、主机和服务边界

1. 唯一规范代码仓库是 `/home/team/zhanghaonan/ConflictStudio`。
2. 唯一规范数据目录是 `/home/team/zhanghaonan/ConflictStudio-data`。
3. 唯一规范配置文件是 `/home/team/zhanghaonan/ConflictStudio/ConflictStudio.env`。
4. 外网访问只允许走 g203 代理。不得改成其他代理路径，也不得直连外网。
5. 不在 Windows 上开发。Windows 只用于连接、查看和调度，代码修改、验证和 Git 操作都在 6403 的规范仓库完成。
6. 8888 是受保护的旧服务。不得重启、切换、改配置、改隧道、改进程或改数据。
7. 本轮交接不改 8890、systemd、GPU、服务、数据、TAFFC、分支、工作树、克隆、副本、备份或部署目录。

### 1.2 生成产品边界

1. 生成区顶部只保留 Test、Generate、Results 三个入口，对应 `/generate/test`、`/generate/production`、`/generate/results`。
2. 助手只出现在 Test 和 Generate。它把自然语言要求转成页面上可见、可检查的配置，并给出建议；它不能进入 Review。
3. 助手不能修改现有数据集或现有资源。它只能提出新的内容脚本草稿或场景草稿，用户统一确认后才可创建 Draft。其他受保护改动也只能经过一次统一确认，不能分散确认或暗中执行。
4. 内容脚本、场景、提示词模板是独立资源。内容脚本与场景只能通过明确的兼容关系组合，禁止自动自由笛卡尔配对。
5. 最终提示词只有一条正向提示词和一条大部分固定的负向提示词。不要暴露系统提示词、内部输入或中间提示词。
6. 正式生成必须先明确列出全部内容与场景组合，再与人口属性组合。总视频数是明确组合数乘以种子数。每个种子都重复全部组合，不能把种子分摊到组合上。
7. 同时选两张 GPU 时，两张卡生成彼此独立的视频，不能共同生成同一个视频。
8. Test 生成的媒体永远不是正式数据。即使以后用相同配置正式重渲染，Test 媒体也不能提升、复制或复用为正式样本。
9. ConflictStudio 只接收新生成的数据。旧数据继续留在 sort_front，不迁移、不改写，也不混入新的正式数据集。

### 1.3 Review 产品边界

1. Review 必须拆成列表页和详情页。
2. Review 不显示 VLM、快捷动作、提示词、种子、尝试记录或其他内部生成字段。
3. 备注自动保存。没有 reviewer 时页面只读，不能提交审核、转换或备注写入。
4. 分类转换只记录操作人，不把 reviewer 当成审核结论作者。转换请求必须明确携带 `reviewerId`。
5. 不兼容样本要显示兼容场景数量、原因和去往 Generate 的链接。数量为零时必须有直白说明，不能只显示空状态。

### 1.4 工程和界面边界

1. 不增加哈希、校验和或 ETag 校验。
2. 不增加兜底路径、降级路径或兼容层。旧代码和旧契约应直接删除。
3. 中文和英文文案必须分别编写，不能用一种语言拼另一种语言。
4. 界面不使用口号、AI 字样、内部字段名或原始错误文本。
5. 界面不使用居中点分隔。破折号和引号只在语义确实需要时使用。正文使用普通文本。
6. 时间统一显示到北京时间秒级，不显示 UTC 标签。

## 2. Git 实现基线

### 2.1 只读检查结果

检查时间是北京时间 `2026-08-17 22:54:04`。这是创建本交接文档之前的实现基线。

1. 仓库：`/home/team/zhanghaonan/ConflictStudio`
2. 分支：`master`
3. 实现 HEAD：`da6e2ba`
4. 跟踪分支：`origin/master`
5. 当时远端 `master`：`88fcebe`
6. 跟踪关系：领先 21，落后 0。
7. 暂存区为空。
8. 唯一未提交的已跟踪文件是 `backend/adapters/production_renderer.py`。
9. `docs/NEXT_SESSION_HANDOFF.md` 在检查时尚不存在。

### 2.2 尚未推送的 21 个提交

以下按从旧到新的顺序列出。

| 顺序 | 提交 | 目的 |
| --- | --- | --- |
| 1 | `2194c81` | 把运行时仓库、数据和配置路径收敛到新的规范路径，并同步运行脚本、systemd 单元、说明和路径测试。 |
| 2 | `3009327` | 重建内容脚本、场景、兼容关系、提示词模板及其版本的后端领域模型、服务和 API。 |
| 3 | `9f03bbf` | 让前端契约、查询、页面和双语文案使用新的目录与模板术语。 |
| 4 | `8feb6ba` | 引入提示词模板版本，并把提示词测试、视频测试及其结果与正式生成隔离。 |
| 5 | `0fb9839` | 把 Test 媒体来源完整封存在 SQLite 中，防止测试媒体失去来源或进入正式数据。 |
| 6 | `279d721` | 持久化明确选择的批次组合，避免运行时重新做自由配对。 |
| 7 | `c136006` | 支持数据集合并样本，同时保持审核历史不变。 |
| 8 | `6d0cdb1` | 增加需要确认的配置助手，把自然语言候选映射到明确的可见配置。 |
| 9 | `375de3e` | 增加中断任务恢复和失败条目重试，并补齐执行器与渲染器契约。 |
| 10 | `d8d6d13` | 增加服务端备注草稿和并发安全的审核流程。 |
| 11 | `4041a17` | 清理既有后端 lint 问题。 |
| 12 | `4cfe9fd` | 把生成导航收敛为 Test、Generate、Results 三页。 |
| 13 | `a751bc1` | 重建三页生成工作流、助手面板、结果视图和页面样式。 |
| 14 | `08a1c0c` | 让浏览器检查与新的三条生成路由一致。 |
| 15 | `04a7ea2` | 加入已批准并规范化的初始目录资源。 |
| 16 | `250770d` | 增加事务式全新目录初始化器和对应测试。 |
| 17 | `0badbaa` | 完成 Generate 的配置助手、候选选择、一次确认和表单应用流程。 |
| 18 | `90fb11b` | 给 Review 后端详情补充界面所需的样本展示字段。 |
| 19 | `9298546` | 完成 Test 资源管理、提示词测试和视频测试工作流。 |
| 20 | `6a7c631` | 在 Results 的任务响应中暴露实际模型配置。 |
| 21 | `da6e2ba` | 完成 Results 的任务与输出分页、媒体角色、任务控制和可读详情。 |

### 2.3 未完成的 renderer WIP

`backend/adapters/production_renderer.py` 是唯一的未暂存 WIP。检查时文件大小为 43781 字节，修改时间是北京时间 `2026-08-17 22:40:01`。文本差异是增加 180 行、删除 28 行，共涉及 208 行。

这份 WIP 正在补充渲染提交后的补偿失败处理、任务与条目的终态失败持久化、运行中尝试关闭、GPU 槽释放、失败事件和上下文清理。它还没有完成，也没有形成经过验证的提交。下一会话必须先逐行评审这份差异，再补测试并完成实现。任何 reset、restore 或其他丢弃工作区修改的操作之前，都必须先评审这份 WIP；不能把它当成可丢弃残留。

## 3. 已完成状态

### 3.1 验证基线

1. renderer WIP 出现之前的后端完整基线是 `486 passed`。
2. 前端完整 `check`、独立 `typecheck` 和 `build` 均已通过。
3. 本次交接只读复核了三个聚焦测试：API 接线 23 项通过，Test 工作流 7 项通过，Results 工作流 7 项通过。
4. 上述后端 486 项不是对当前 renderer WIP 的验收。WIP 仍需单独完成和重新测试。

### 3.2 初始目录

事务式全新初始化器的固定结果是：

| 资源 | 数量 |
| --- | ---: |
| 内容脚本 | 104 |
| 启用内容脚本 | 8 |
| 草稿内容脚本 | 94 |
| 停用内容脚本 | 2 |
| 场景 | 75 |
| 明确兼容关系 | 75 |
| 提示词模板 | 4 |
| 已验证初始版本 | 4 |
| 示例 | 0 |

四个初始模板版本都是第 1 版、Verified，且正向示例和负向示例都为空。

### 3.3 Test 当前状态

1. 页面路由是 `/generate/test`。
2. 内容脚本和场景只能新建为 Draft。内容脚本、场景、模板和模板版本各自独立管理。
3. 兼容场景只能逐项明确选择。Fixed 内容只能绑定其固定场景，Generative 内容只能使用明确勾选的兼容场景。
4. 新模板版本是不可变 Draft。只有同页完成过提示词测试的 Draft 版本才能进入验证确认。
5. 提示词测试和视频测试使用当前 `/api/test-runs/prompt` 与 `/api/test-runs/video` 契约，并显示完整最终正向提示词和负向提示词。
6. 支持 LTX-2.3、LTX-2.5 和 MiniMax H3。LTX-2.5 必须明确选 BF16 或 INT8；另外两个模型不接受 precision。
7. 助手可以在一次确认后把建议应用到可见 Test 配置，但不能创建资源，也不能替用户运行测试。
8. Test 页面没有正式数据集提升入口，所有控件都是受控状态。

### 3.4 Generate 当前状态

1. 页面路由是 `/generate/production`，界面标签是 Generate。
2. 正式表单明确保存目标数据集、英文显示名、类别、冲突方向、模板版本、内容与场景选择、人口属性、种子、模型、precision 和 GPU 槽。
3. Fixed 内容只接受唯一固定场景。Generative 内容只接受其明确兼容且明确选中的场景。
4. 预览和提交都基于持久化批次草稿及 revision。助手给出的多个候选必须由用户明确选择，并在一次统一确认后应用。
5. 提交只接受一张或两张当前可用 GPU。全部明确组合和全部种子都进入持久化请求。
6. 从 Test 复制到 Generate 的只是页面上可见的配置，不带 Test 媒体、资产或数据集提升状态。

### 3.5 Results 当前状态

1. 页面路由是 `/generate/results`。
2. Test 任务与正式任务分开查询和展示。任务列表和输出列表都使用服务端每页 20 项分页。
3. 任务名称使用北京时间到秒，进度显示为已结束条目数除以总数，并显示实际模型配置。
4. Running 可取消，Interrupted 可恢复，有失败条目的 Failed 任务可重试。操作携带任务 revision 和条目 revision。
5. 事件通过持久化事件查询和 WebSocket 回放更新，事件区有固定高度和滚动。
6. VA 的主视频有声播放。VT 同时区分有声源视频和静音主视频，角色不会混用。
7. 最终正向提示词和负向提示词分块显示，并支持长文本换行。
8. 空列表、筛选后为空、网络失败和服务失败是不同状态。界面使用稳定字段映射文案，不显示后端原始错误。
9. Test 结果可以把可见配置复制回 Test 草稿，但不能提升或复用媒体和资产。

## 4. 未完成工作的固定优先级

下面的顺序不可跳过。每一步完成后都要满足本节的完成标准，再进入下一步。

1. 完成并测试 renderer WIP。先评审现有文本差异，补齐提交后失败、补偿失败、终态持久化、事件、槽状态和恢复路径测试。完成标准是目标测试与后端全量测试通过，WIP 不再以未提交状态存在。
2. 验证 DeepSeek key。只能从规范配置读取并发出最小真实请求，不能打印、复制或记录 key。完成标准是只留下成功或失败、模型名、时间和非敏感响应状态。
3. 重建 Review。严格执行第 5 节的契约、页面和浏览器清单。完成标准是旧单页与旧批量审核路径全部删除，新的列表页和详情页通过后端、前端和浏览器验收。
4. 建立规范 env、数据和配置。完成标准是代码只从三个规范路径运行，旧 TAFFC 路径不再被运行时引用，检查过程不显示秘密。
5. 用全新数据库执行目录 seed。完成标准是精确得到 104、75、75、4、4、0 及 8、94、2，并证明初始化是事务式且可重复拒绝脏状态。
6. 做真实 DeepSeek 和模型测试。覆盖 LTX-2.3、LTX-2.5 的 BF16 与 INT8、MiniMax H3，以及 VA 有声主视频和 VT 静音主视频加源音频。完成标准是每条路径有真实任务、媒体和音频证据，且 Test 与正式数据仍隔离。
7. 把 8890 切到规范仓库、规范数据和规范配置。完成标准是实际链路不再落到 TAFFC 旧部署，健康检查、API、媒体和 WebSocket 都来自规范路径，同时 8888 的 PID、启动时间和 HTTP 200 基线不变。
8. 做真实浏览器检查。覆盖生成三页和 Review 的指定宽度、双语、返回恢复、媒体、备注状态和错误状态。完成标准是没有横向溢出、原始错误、内部字段或状态丢失。
9. 完成三轮 Review 验收。第一轮检查契约和数据正确性，第二轮检查交互与响应式，第三轮检查双语文案和边界。每轮问题修完后重新跑该轮，三轮都必须为零阻塞问题。
10. 只在规范 8890 完整验收后清理 TAFFC。只能使用第 7 节允许列表。完成标准是允许项按精确路径处理，保护项全部存在且未变，临时目录只处理已解析和逐项确认的顶层路径。
11. 做最终同步。完成标准是 `master` 与 `origin/master` 同步，没有未提交代码，没有未推送提交，规范部署证据完整，renderer WIP 已形成独立可追踪提交，所有子代理关闭。

## 5. Review 重建精确清单

### 5.1 路由、外壳和契约

1. 增加列表路由 `/review` 和详情路由 `/review/:sampleId`。
2. AppShell 在两个路由上都显示正确的 Review 标题、主导航激活状态和可返回路径。
3. 后端和前端契约拆成列表、详情、媒体、备注、审核、下一条六类，不再用一个巨型详情响应承载全部行为。
4. 审核写入使用请求队列。请求带 `expectedNoteDraftRevision`，审核请求本身不带 note。
5. 分类转换请求必须带 `reviewerId`，转换记录只把它作为操作人。
6. 支持 relation 和 direction 筛选。搜索和分页都在服务端完成，固定每页 20 项。
7. 备注使用独立 GET 和 PUT。详情提供 `nextReference`。所有写入后只失效相关列表、详情、备注和下一条缓存。
8. 冲突、revision 变化和失效引用必须显示人能读懂的中文或英文说明，不能显示内部错误码或原始响应。

### 5.2 列表页

1. 每行显示缩略图、样本 ID、数据集、A 或 C、VA 或 VT、真实情感、表面情感、冲突方向、性别和审核状态。
2. 搜索、筛选、页码和选中项都写入 URL 状态，刷新和返回后可恢复。
3. 批量操作只作用于当前页。删除批量备注，不允许跨页暗选。
4. 没有 reviewer 时整页只读，不能选中、审核、转换或写备注。
5. 从详情返回时恢复原 URL、页码和滚动位置。

### 5.3 详情页

1. 宽度大于等于 1280 时使用两列，小于 1280 时使用一列。
2. 视频使用 contain，不得溢出容器。
3. VA 默认以有声主视频为主。VT 默认以静音主视频为主，并提供源音频开关。
4. 核心信息显示真实情感、对白或屏幕文字、关系、协议和冲突方向。
5. 人口属性、模型、precision 和北京时间折叠显示，时间精确到秒且没有 UTC 标签。
6. 不显示 VLM、快捷动作、提示词、种子、尝试、GPU、内部路径或其他敏感生成字段。
7. 备注自动保存，并明确显示未修改、保存中、已保存、保存失败和重试状态。没有 reviewer 时不能保存。
8. 审核成功后按 `nextReference` 自动进入下一条，并能跨页继续。没有下一条时显示完成状态。
9. 分类转换只记录操作人。转换后按新 revision 刷新详情、列表、备注和下一条。
10. `compatibleSceneCount` 为零时显示原因和去 Generate 的链接；大于零时也显示数量和链接，不直接替用户生成。
11. Archive 中指向样本的返回位置使用 `/review/{id}`。

### 5.4 必须删除的旧实现

1. 删除旧 `frontend/src/generationPrefill.ts` 及其从 Review 到旧批次表单的路径。
2. 删除旧 Review 单页布局、批量备注、兼容场景直接重生成按钮及对应旧样式。
3. 删除旧 Review 翻译键、sessionStorage key、导航 prefill 和依赖这些行为的测试。
4. 重写 `scripts/review-archive.test.mts` 与 `scripts/review-browser-check.mjs` 中的旧 Review 假设，不保留兼容断言。

### 5.5 浏览器验收

1. 宽度覆盖 1440、1024、768、390。
2. 每个关键流程覆盖中文和英文。
3. 覆盖列表进入详情、详情返回并恢复页码与滚动、跨页下一条。
4. 覆盖 VT 默认静音主视频、源音频开关和 VA 有声主视频。
5. 覆盖备注未修改、保存中、已保存、失败、重试和 revision 冲突。
6. 覆盖没有 reviewer 的只读状态，确认没有任何写请求。

## 6. 8890 部署审计基线

### 6.1 审计时间和实际链路

审计发生在北京时间 `2026-08-17 21:23` 至 `21:34`。当时的实际链路是：

`g203:8890 -> nginx -> 127.0.0.1:18003 -> SSH reverse tunnel -> 6403:8001 -> /home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-88fcebe`

当时使用的数据目录是 `/home/team/zhanghaonan/TAFFC/ConflictStudio-data`，配置文件是 `/home/team/zhanghaonan/TAFFC/ConflictStudio.env`。当时规范数据目录 `/home/team/zhanghaonan/ConflictStudio-data` 和规范配置 `/home/team/zhanghaonan/ConflictStudio/ConflictStudio.env` 都缺失，因此 8890 不是规范部署。该结论只描述当时审计，不代表下一会话开始时仍然不变。

### 6.2 Python 和依赖

最终运行环境必须是 Python 3.10 或更高，并满足：

| 依赖 | 版本范围 |
| --- | --- |
| fastapi | `>=0.116,<1` |
| httpx | `>=0.28,<1` |
| Jinja2 | `>=3.1,<4` |
| pydantic | `>=2.11,<3` |
| PyYAML | `>=6,<7` |
| sqlmodel | `>=0.0.24,<0.1` |
| uvicorn | `>=0.35,<1` |
| websockets | `>=15,<16` |

`mprisk` 环境当时不能满足全部依赖。旧部署 venv 也不是最终环境，不能直接作为规范运行环境。

### 6.3 模型单元和 GPU 快照

当时审计到八个用户单元，全部仍指向旧 TAFFC 数据根，并且都是 inactive/dead：

1. `conflictstudio-ltx-gpu0`
2. `conflictstudio-ltx-gpu1`
3. `conflictstudio-h3-gpu0`
4. `conflictstudio-h3-gpu1`
5. `conflictstudio-ltx25-bf16-gpu0`
6. `conflictstudio-ltx25-bf16-gpu1`
7. `conflictstudio-ltx25-int8-gpu0`
8. `conflictstudio-ltx25-int8-gpu1`

GPU 快照时间是北京时间 `2026-08-17 21:28:43`。两张 A100 当时都是 `14/81920 MiB`、利用率 `0%`，没有进程，也没有模型端口。这个快照已经过时，任何生成或切换前都必须重新只读检查。

### 6.4 8888 保护基线和缺失证据

1. g203 的 `sort-front-web` 当时 active，PID 是 `1541`，启动时间是北京时间 `2026-08-14 11:42:55`。
2. 6403 的旧隧道 PID 是 `1590`，旧后端 PID 是 `1592`。
3. 8888 当时 HTTP 200。不得触碰这条链路。
4. 当时没有真实 DeepSeek 成功证据。
5. 当时没有 LTX-2.3、LTX-2.5、MiniMax H3 三个模型族的真实生成证据，也没有 VA 与 VT 音频角色的真实证据。

## 7. TAFFC 清理边界

### 7.1 唯一触发条件

只有在 8890 已经从规范仓库、规范数据和规范配置运行，并完成 API、媒体、WebSocket、真实模型、浏览器及 8888 不变验收后，才允许开始清理。清理是不可逆操作，不能提前做。

### 7.2 精确允许列表

除下列完整路径外，不得处理其他 TAFFC 路径：

1. `/home/team/zhanghaonan/TAFFC/.ConflictStudio-ee616e9.bundle`
2. `/home/team/zhanghaonan/TAFFC/ConflictStudio`
3. `/home/team/zhanghaonan/TAFFC/ConflictStudio-data`
4. `/home/team/zhanghaonan/TAFFC/ConflictStudio.env`
5. `/home/team/zhanghaonan/TAFFC/ConflictStudio-import-report-20260809.json`
6. `/home/team/zhanghaonan/TAFFC/ConflictStudio-import-sample-status-20260809.jsonl`
7. `/home/team/zhanghaonan/TAFFC/ConflictStudio-master-9bbcd7cdd3e79943.bundle`
8. `/home/team/zhanghaonan/TAFFC/ConflictStudio-migration-work`
9. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-093848e`
10. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-10c75d0`
11. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-1488d52`
12. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-28311e8`
13. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-2b3cdfe`
14. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-4cde7de`
15. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-4d7edbd`
16. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-4f79aa2`
17. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-5048207`
18. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-75e70c2`
19. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-77e6195`
20. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-83d50aa`
21. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-85e18c4`
22. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-88fcebe`
23. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-8aafb47`
24. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-8f522b6`
25. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-9bbcd7c`
26. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-b5be288`
27. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-c5c8390`
28. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-d24bcb6`
29. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-d42d2f2`
30. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-d5ad1cf`
31. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-dee6949`
32. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-df58a9e`
33. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-ee616e9`
34. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-f1900f1`
35. `/home/team/zhanghaonan/TAFFC/ConflictStudio-deploy-f80b45f`

### 7.3 明确保护项

以下路径不得处理：

1. `/home/team/zhanghaonan/TAFFC/article`
2. `/home/team/zhanghaonan/TAFFC/artifacts`
3. `/home/team/zhanghaonan/TAFFC/datasets`
4. `/home/team/zhanghaonan/TAFFC/mprisk`
5. `/home/team/zhanghaonan/TAFFC/mprisk-data`
6. `/home/team/zhanghaonan/TAFFC/mprisk-evidence-a23ce1bb`
7. `/home/team/zhanghaonan/TAFFC/mprisk-v2`
8. `/home/team/lvshuyang/prompt-make`
9. `/home/team/zhanghaonan/ConflictStudio`
10. `/home/team/zhanghaonan/ConflictStudio-data`
11. `/home/team/zhanghaonan/ConflictStudio/ConflictStudio.env`

### 7.4 `/tmp` 边界

`/tmp` 只能处理事先逐项列出、解析为真实顶层路径并再次确认的 `/tmp/ConflictStudio-*` 或 `/tmp/conflictstudio-*`。禁止对 `/tmp`、通配结果、未解析变量或计算出的父目录做宽泛递归处理。每个目标都必须先证明是顶层项且不越出允许模式。清理不可逆。

## 8. 命令和验证类别

本节只定义类别和安全输出，不给出秘密或破坏性命令。

1. Git 类：只读查看分支、跟踪关系、短提交记录、工作区文本差异、差异统计、暂存范围和 `git diff --check`。同步前先 fetch，再证明远端没有意外前进且推送是 fast-forward。永不 force。
2. renderer 类：运行目标单元测试、失败注入测试、恢复与重试测试，再运行后端全量 pytest 和 Python 编译检查。
3. 前端类：运行 `npm run check`、`npm run typecheck`、`npm run build`，再运行 Test、Generate、Results、Review 的聚焦 Node 测试。
4. 目录类：只在隔离的全新数据库运行初始化器，并读取资源数量、状态、兼容关系、模板版本和示例数量。
5. DeepSeek 类：从规范配置在进程内读取 key，发出最小真实请求，只记录是否成功、模型名、时间和非敏感状态。任何输出都不能包含 key。
6. 模型类：先只读检查 GPU、进程、端口和单元状态，再按一个模型配置一个任务验证媒体和音频角色。不能把旧快照当成当前结果。
7. 部署类：检查 8890 的实际进程工作目录、数据根、配置来源、HTTP、API、Range 媒体和 WebSocket，并单独对比 8888 的 PID、启动时间和 HTTP 状态。
8. 浏览器类：按指定宽度和语言执行真实路由、返回恢复、分页、媒体、备注、只读和错误状态检查。
9. 清理类：只做路径清单、真实路径解析、允许列表比对、保护项比对和操作后逐项复核。文档中不保存任何删除命令。

## 9. 总体验收标准

只有同时满足以下条件，整个交接目标才算完成：

1. renderer WIP 已评审、完成、测试并形成独立提交，没有被 reset 或 restore 丢失。
2. 后端全量测试、前端 check、typecheck、build 和所有聚焦测试通过。
3. Review 第 5 节全部完成，旧 generationPrefill、旧样式、旧键和旧测试已直接删除。
4. 规范仓库、数据和配置成为唯一运行来源，全新数据库 seed 数量精确匹配。
5. DeepSeek、三个模型族、LTX-2.5 两种 precision、VA 和 VT 都有新的真实证据。
6. 8890 完成规范切换和真实浏览器验收，8888 的受保护基线未变。
7. 三轮 Review 验收均无阻塞问题。
8. TAFFC 清理只发生在所有前置验收之后，且只处理精确允许列表。
9. `master` 与 `origin/master` 最终同步，工作区干净，没有未推送提交，没有运行中的子代理。
