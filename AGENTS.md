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
- Git 按个人开发流程：每项开发在短分支上进行，完成后直接合并到 main，不开 PR。
- 先在 Windows 上开发和测试。技术栈用 TypeScript/Node。
- 分工：Claude 维护 `docs/` 下的规格和方案；Codex 按 tasks.md 执行，不修改 spec.md 和 plan.md；全部完成后由 Claude 审查代码。
