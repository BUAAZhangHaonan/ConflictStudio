# ConflictStudio 当前交付与维护交接

更新时间：2026 年 8 月 20 日

## 当前部署

- 唯一代码仓库：`/home/team/zhanghaonan/ConflictStudio`
- 分支：`master`
- 唯一数据目录：`/home/team/zhanghaonan/ConflictStudio-data`
- 唯一配置文件：`/home/team/zhanghaonan/ConflictStudio/ConflictStudio.env`
- 8890 运行单元：`conflictstudio-preview.service`
- 6403 应用端口：`127.0.0.1:8001`
- 局域网入口：`http://10.134.132.166:8890`
- 8888 是旧 sort_front，继续独立运行，不属于 ConflictStudio。
- 8889 是 MPRisk Curation，继续独立运行。

8890 已从规范仓库、规范数据目录和规范配置运行。TAFFC 顶层的 ConflictStudio 旧仓库、部署副本、旧数据、旧配置、迁移目录和 bundle 已全部删除，顶层匹配数量为 0。以下论文与 MPRisk 路径仍保留：

- `/home/team/zhanghaonan/TAFFC/article`
- `/home/team/zhanghaonan/TAFFC/artifacts`
- `/home/team/zhanghaonan/TAFFC/datasets`
- `/home/team/zhanghaonan/TAFFC/mprisk`
- `/home/team/zhanghaonan/TAFFC/mprisk-data`
- `/home/team/zhanghaonan/TAFFC/mprisk-evidence-a23ce1bb`
- `/home/team/zhanghaonan/TAFFC/mprisk-v2`

## 已完成功能

### 生成

- 生成区只保留测试、生成和结果三页。
- 内容脚本、拍摄场景和提示词模板分别管理，通过明确兼容关系组合。
- 正式生成按已选组合、人口属性和种子计算完整任务数量。
- 支持单卡和双卡。双卡分别生成不同视频。
- 配置助手支持未保存的正式批次，使用 `deepseek-v4-flash` 把自然语言整理成可见配置，用户确认后才应用。
- 测试数据和正式数据完全分开。测试视频不能进入正式数据集。
- 支持 LTX-2.3、LTX-2.5 BF16、LTX-2.5 INT8 和 MiniMax H3。
- 结果页支持任务分页、输出分页、事件回放、取消、恢复和失败项重试。

### 审核与归档

- 审核使用独立列表页和详情页。
- 列表支持名称搜索、数据集名称筛选、状态筛选和每页 20 条。
- 详情支持 VA 有声主视频、VT 静音主视频和 VT 带声源视频切换。
- 没有标注员时只读，备注不会发起写入。
- 备注自动保存。类别转换后会清除过期草稿。
- A 类转 C 类时必须选择不同的表面情感和协议允许的冲突方向。
- 详情打开时从顶部开始，返回列表时恢复原筛选、页码和滚动位置。
- 归档保持单一清单原位更新，当前测试数据没有进入归档。

### 前端

- 中文和英文独立显示。
- 已检查 1440、1024、768 和 390 四种宽度。
- 小屏使用任务卡和样本卡，不依赖横向表格。
- 移动导航、媒体比例、只读状态、分页、单复数、情感文案和模板名称均已修复。
- 普通页面不显示内部字段、原始枚举、接口名称、绝对路径或密钥。

## 验证记录

- 后端完整测试：500 项通过。
- 前端 `npm run check` 通过，包含 TypeScript、前端测试、Vite 构建、文案检查和构建产物检查。
- Playwright 已覆盖 1440、1024、768、390，以及中文和英文关键流程。
- SQLite 完整性检查为 `ok`，外键检查无异常。
- 媒体 Range 返回 HTTP 206，没有 ETag。
- WebSocket 返回 HTTP 101，并能回放 SQLite 中的持久任务事件。

DeepSeek 已完成真实请求验证：

- 模型：`deepseek-v4-flash`
- HTTP：201
- 状态：`Pending`
- 返回包含 `missingFields`、`prefill`、`candidates` 和 `recommendations`
- 请求与记录均未显示 API Key

真实视频验证共 5 条：

| 用途 | 模型 | 配置 | 结果 |
| --- | --- | --- | --- |
| 正式生成 | LTX-2.5 | INT8，A-VA | `CS-000001`，有声主视频 |
| 正式生成 | LTX-2.5 | INT8，C-VT | `CS-000002`，静音主视频和带声源视频 |
| 测试 | LTX-2.5 | BF16，C-VT | 完成，不进入正式数据集 |
| 测试 | LTX-2.3 | C-VT | 完成，不进入正式数据集 |
| 测试 | MiniMax H3 | C-VT | 完成，不进入正式数据集 |

LTX 视频为 1344×768、24 帧每秒、121 帧。H3 视频为 1344×768、24 帧每秒、124 帧。VA 音轨、VT 静音主媒体和 VT 带声源媒体均已用 ffprobe 和解码检查确认。

真实生成结束后：

- 八个模型单元全部为 inactive。
- 8188 和 8189 没有监听。
- 两张 GPU 均已释放，没有计算进程。

## 独立审阅

三轮独立审阅已经完成。审阅覆盖后端契约与数据、生成与审核前端、响应式和双语、部署恢复、真实媒体、任务事件、TAFFC 清理和 Git 状态。发现的问题已经修复并重新验证，包括：

- 类别转换时的情感与方向校验
- 类别转换后的备注草稿失效
- 审核列表和结果页的小屏布局
- 列表与详情的滚动位置
- 无标注员只读状态
- 数据集名称筛选
- 配置助手对未保存批次的支持
- 内容搜索和跨页选择

没有遗留 P0 问题。

## Git 交付状态

应用功能基线提交为 `0941b3c`。创建本文档前，`master` 工作树干净。最终交付只允许普通 fast-forward 推送到 `origin/master`，禁止 force push。完成推送后应同时满足：

```bash
cd /home/team/zhanghaonan/ConflictStudio
git status --short
git rev-parse HEAD
git rev-parse origin/master
```

`git status --short` 应为空，后两个提交号应相同。

## 简洁运行与维护

检查应用：

```bash
systemctl --user status conflictstudio-preview.service
curl -sS http://127.0.0.1:8001/api/health
```

重启 8890 应用时只操作：

```bash
systemctl --user restart conflictstudio-preview.service
```

不要因此重启 8888、8889、反向隧道或模型单元。视频任务提交前由系统检查 GPU 和端口；任务结束后通过应用释放接口释放模型。未知 GPU 进程不能停止。

常规验证：

```bash
cd /home/team/zhanghaonan/ConflictStudio
CONFLICTSTUDIO_PYTHON=.venv/bin/python bash scripts/integrate.sh test
npm run check
```

配置文件不得提交。维护时只检查密钥是否存在，不输出或复制密钥。新功能应保持测试、正式数据、审核和归档之间的现有边界，不增加旧格式兼容层或额外部署副本。
