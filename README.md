# ConflictStudio

ConflictStudio 是一个用于多模态冲突样本生成、审核和归档的原型。当前前端使用 React、TypeScript 和 Vite，数据保存在浏览器 `localStorage` 中；后端提供健康检查、样本和统计接口。

## 本地开发

```bash
npm install --no-package-lock
npm --prefix frontend install --no-package-lock
npm run dev
```

常用检查：

```bash
npm run typecheck
npm run build
npm run copy:check
python -m unittest discover -s backend/tests
```

构建产物位于 `frontend/dist`，包含 `index.html`、`assets/app.js` 和 `assets/app.css`。

## 功能范围

- 工作区：数据集、任务、活动和待处理事项。
- 生成：批量生成、单次测试、内容、预设和任务详情。
- 审核：媒体预览、单条或批量决策、备注和类别转移。
- 归档：同步预览、当前样本和 JSONL 导出。
- 设置与统计：姓名、语言、GPU 状态、审核统计和活动趋势。

## 后端配置

后端入口是 `backend/app.py`。部署环境可以提供 `PORT` 和前端构建目录等配置；密钥不应写入仓库。部署配置位于 `deploy/`，根级脚本只负责调用现有工具，不会自动创建环境或导入数据。
