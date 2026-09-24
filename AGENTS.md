# AGENTS.md

Codex 上下文素材管理器（暂名）：让用户逐轮决定，Codex 任务里的哪些图片和文件进入下一轮请求。

## 从哪里读起

- [docs/spec.md](docs/spec.md)：目标、范围、硬约束和验收标准，是唯一的事实来源。
- [docs/plan.md](docs/plan.md)：技术方案。
- [docs/tasks.md](docs/tasks.md)：当前任务。
- [IDEA.md](IDEA.md)：最初的构想，已被 spec 取代，不作依据。

## 已确认的规矩

- 原始对话记录和素材文件始终只读。
- 真实数据不进仓库：从真实会话和用户素材里提取的内容只能放在 `local/`（已被 git 忽略），任何时候都不提交。
- 仓库里的文档和代码不写用户本机的具体路径；通用位置（如 `~/.codex`、`%LOCALAPPDATA%`）可以写。
- 先在 Windows 上开发和测试。技术栈用 TypeScript/Node。
- 界面开发：Claude 自己截图检查效果；做到界面的关键节点时，截图给用户看，停下来等反馈再继续（用户 2026-09-24 确认）。
- 测试时调用模型一律用 `gpt-6-sol`，推理强度 `low`，包括脚本自测和桌面版测试，为了省 token（用户 2026-09-24 要求）。
- 分工：Claude 维护 `docs/` 下的规格和方案，并负责开发和测试（阶段 0 的 T0–T2 由 Codex 完成；测试需要在 Codex 之外启动 app-server，所以从 T3 起改由 Claude 执行）。其他协作者不修改 spec.md 和 plan.md。

## Git 规范

- 只维护 `main` 一条长期分支，暂不设 `develop` 等分支。`main` 必须始终可用。
- 不直接在 `main` 上提交。每项工作都开一个短分支，命名格式为“类型/简短描述”，例如 `spike/phase0`、`feat/asset-index`、`fix/rollout-parse`、`docs/spec-update`。
- 提交信息用约定式格式：`类型(范围): 描述`，例如 `feat(indexer): 解析内联图片`。
- 合并前先验证，确认相关测试和检查都通过。然后用 `git merge --no-ff` 合并到 `main`，不开 PR，合并后删除短分支。
- 不对 `main` 强推，不改写 `main` 上已经推送的历史。
- 远程只用 SSH（`git@github.com:…`），不用 HTTPS。
