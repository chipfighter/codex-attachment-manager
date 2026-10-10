# AGENTS.md

Context Attachment Manager（上下文素材管理器，2026-10-11 前叫 Codex Attachment Manager）：让用户逐轮决定，Codex 任务和 Claude Code 会话里的哪些图片和文件进入下一轮请求。

## 从哪里读起

- [docs/spec.md](docs/spec.md)：目标、范围、硬约束和验收标准，是唯一的事实来源，描述当前版本。
- [docs/design.md](docs/design.md)：技术方案，讲现在是怎么实现的。
- [docs/v0.4/plan.md](docs/v0.4/plan.md)：Claude 桌面 Code 接入的 v0.4 变更方案；任务和验收分别见同目录的 `tasks.md`、`acceptance.md`。当前正式规格仍以 `docs/spec.md` 为准，未通过的迁移关卡不算已实现。
- [docs/history/v0.1/](docs/history/v0.1/)：v0.1 的开发记录（原方案、任务记录、各阶段报告、最初的构想），只作参考，不作依据。
- [CHANGELOG.md](CHANGELOG.md)：每个版本的更新记录，发布时就是 Release 说明。

## 已确认的规矩

- 原始对话记录和素材文件始终只读。
- 真实数据不进仓库：从真实会话和用户素材里提取的内容只能放在本机的 `local/`（已被 git 忽略）或工具的数据目录（Windows 是 `%USERPROFILE%\.codex-attachment-manager`），任何时候都不提交。
- 插件本体在 `plugin/`（`plugin/src` 是运行代码），测试和实验脚本在 `spike/`，一行命令用的安装、卸载脚本在 `scripts/`。改动运行代码后，要重新运行 `cam install`，Codex 缓存里的插件副本才会更新；不要让已安装的配置指向不存在的文件。
- `scripts/*.ps1` 只用 ASCII 字符：Windows PowerShell 5.1 用 `irm … | iex` 下载时按 Latin-1 解码，中文会乱码。
- 仓库里的文档和代码不写用户本机的具体路径；通用位置（如 `~/.codex`、`%LOCALAPPDATA%`）可以写。
- 对外的信息以英文为主：README.md、仓库简介、CHANGELOG.md（发布时就是 Release 说明）用英文，README_CN.md 是中文版；`docs/` 下的规格、方案和开发记录，以及本文件，保持中文（用户 2026-09-28 定）。
- 先在 Windows 上开发和测试。技术栈用 TypeScript/Node。
- 界面开发：Claude 自己截图检查效果；做到界面的关键节点时，截图给用户看，停下来等反馈再继续（用户 2026-09-24 确认）。
- 测试时调用模型一律用 `gpt-6-sol`，推理强度 `low`，包括脚本自测和桌面版测试，为了省 token（用户 2026-09-24 要求）。
- 界面和提示文字分简体中文、英文两份：面板的在 `plugin/src/panel.html` 的文字表里，插件服务和命令行的在 `plugin/src/messages.ts`。新增或修改文字时两份一起改，单元测试会检查条目一一对应。改发给模型的占位符和说明（`plugin/src/rewrite.ts`）时，中文、英文（`--lang en`）各跑一次 `spike/src/v01-placeholder-selftest.ts`（用户 2026-09-25 要求）和 `spike/src/v01-needs-selftest.ts`（没有名字的工具截图全部取消后，模型能不能按编号要图、面板能不能认出来；用户 2026-09-26 要求）；改的是自动选图的文字（自动版的占位符和说明、`cam_view_image` 的说明和返回的文字）时，再跑 `spike/src/v03-auto-selftest.ts`（模型该取图时会不会取、不该取时会不会不取；用户 2026-10-06 要求）。这些自测三个 GPT-6 模型都要跑：`gpt-6-sol`、`gpt-6-luna`、`gpt-6-astra`，推理强度 low，用环境变量 `CAM_TEST_MODEL` 切换（用户 2026-09-28 要求）。自测在用户的 Codex 里建的任务，测完由脚本自动归档，不留给用户手动整理（用户 2026-09-28 要求）；遗留的可以用 `spike/scripts/archive-test-threads.ts` 归档。
- 分工：Claude 维护 `docs/` 下的规格和方案，并负责开发和测试（阶段 0 的 T0–T2 由 Codex 完成；测试需要在 Codex 之外启动 app-server，所以从 T3 起改由 Claude 执行）。其他协作者不修改 spec.md 和 design.md。

## Git 规范

- 只维护 `main` 一条长期分支，暂不设 `develop` 等分支。`main` 必须始终可用。
- 不直接在 `main` 上提交。每项工作都开一个短分支，命名格式为“类型/简短描述”，例如 `spike/phase0`、`feat/asset-index`、`fix/rollout-parse`、`docs/spec-update`。
- 提交信息用约定式格式：`类型(范围): 描述`，例如 `feat(indexer): 解析内联图片`。
- 合并前先验证，确认相关测试和检查都通过。然后用 `git merge --no-ff` 合并到 `main`，不开 PR，合并后删除短分支。
- 不对 `main` 强推，不改写 `main` 上已经推送的历史。
- GitHub 上 `main` 有分支保护（用户 2026-09-28 要求）：禁止强推和删除；其他人改 `main` 要提 PR，三个平台的 CI（`test (windows-latest)`、`test (macos-latest)`、`test (ubuntu-latest)`）通过，并由仓库所有者批准。仓库所有者是管理员，不受这些限制，照常在本地 `--no-ff` 合并后推送。
- 远程只用 SSH（`git@github.com:…`），不用 HTTPS。
