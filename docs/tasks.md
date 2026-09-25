# 任务清单

> 方法见 [plan.md](plan.md)。按顺序做，完成一项勾一项，并写明证据放在哪里。

## 当前：v0.1（MVP）

范围见 spec.md 第 4 节“首版（v0.1）”，第 8、9 条是用户 2026-09-25 定的。测试时调用模型一律用 `gpt-6-sol`，推理强度 `low`。

- [x] **v0.1-1 省略图片后，模型不再收回之前的回答**（用户 2026-09-25 报告；证据：`local/v01/placeholder-run1…4.json`；`plugin/src/rewrite.ts`；81 个单元测试）
  - 复现：a.png 重新勾选后，模型答对了；再取消后问“现在能看到吗”，模型说之前的回答是猜的、是错的。
  - 只改占位符的措辞（run1、run2），模型仍然收回。
  - 改成一条开发者消息“上下文管理说明”后（run3、run4），两次结果一致：
    - 说明现在看不到，之前的描述仍然有效；
    - 回忆时照常引用之前的描述；
    - 问之前没描述过的细节时，回复“需要 IMG-001”，没有编造。
- [ ] **v0.1-2 用户做多种情况的测试**【需用户】，同时完成 P5-5：确认插件从 Codex 的缓存启动。
- [x] **v0.1-3 升级时替换旧引擎**（`engine.ts`、`proxy.ts`；新增 3 个单元测试，其中一个真的起两个引擎做交接）
  - 引擎报告自己跑的是哪份代码：运行目录里 .ts 文件的哈希（换行统一成 LF）和插件版本。
  - 插件服务每 3 秒检查一次：代码不同、版本不低于正在运行的引擎，就请它退役。退役的引擎立刻停止监听，空闲连接断开（Codex 会重连到新引擎），正在进行的请求和 WebSocket 这一轮做完再退出，最多等 10 分钟。新引擎马上接手端口；端口一时没放开时重试几秒。
  - 升级前留下的旧插件服务不会把新引擎挤掉：它的目录要么已被替换（读到的是新代码），要么已删除（没有哈希），要么版本更低。v0.1-3 之前的引擎不认识退役请求，直接结束，Codex 会重试被打断的请求。
  - `cam install` 改由装好的副本启动引擎；`cam status` 显示引擎的版本、哈希，以及是否和装好的一致。
- [x] **v0.1-4 macOS、Linux 适配**（用户 2026-09-25 定：这两个平台没法手测，先发布，由用户在 GitHub 上反馈；证据：CI 的冒烟测试在三个平台上通过）
  - 查证：三个平台都有桌面版（Linux 版 2026-08 起预览，包名 `chatgpt`）；macOS 桌面版的命令行在 `<app>/Contents/Resources/codex`；Codex 自己的安装脚本放在 `~/.local/bin/codex`。Codex 启动插件服务时，Windows 上按 PATHEXT 解析命令，macOS、Linux 上直接运行，并在新进程组里启动。
  - 一份 `.mcp.json` 通用：命令写 `./scripts/launch`，Windows 上找到 `launch.cmd`，macOS、Linux 上运行 POSIX 脚本 `scripts/launch`（和 OpenAI 自带插件的做法一致）。
  - 引擎用 `ps` 检测 Codex 进程；macOS 读系统代理（`scutil --proxy`）；数据目录按平台惯例；找 Codex 命令行的位置按平台区分；根目录加 POSIX 版 `cam`。
  - `spike/src/plugin-smoke.ts`：用 Codex 自己的命令行把插件装进临时目录，再由 app-server 开任务，确认插件服务起来、工具和面板都在、引擎启动；不用登录。本机桌面版的命令行（0.155.0-alpha）和 CI 上 npm 的命令行（0.157.0，三个平台）都通过，macOS、Linux 上装进缓存后启动脚本仍可执行。
  - 没验证到的：macOS、Linux 桌面版里的面板显示，以及系统代理下 Codex 能否连到本机引擎，要等用户反馈。
- [x] **v0.1-5 更方便的安装**（`setup.ts`、`panel.html`、`plugin-server.ts`、`scripts/`；新增 3 个单元测试，共 92 个；证据：CI 上三个平台的 `scripts-smoke.ts` 都通过；设计见 plan.md 第 14 节）
  - 不开终端：桌面版的插件页面能“添加插件市场”（来源填 `chipfighter/codex-attachment-manager`），装好插件后，在面板里点“启用”，重启 Codex。
  - 面板：
    - 没接入时显示“启用”；
    - 标题右侧的“停用”要确认一次；
    - 启用、停用后提示重启 Codex 生效；
    - 工具 `cam_setup` 只接受面板的调用。
  - 一行命令：`install.ps1` / `install.sh` 用 Codex 的命令行装插件，再运行装好的副本里的 `cam setup`；`uninstall.ps1` / `uninstall.sh` 不需要 Node 和插件文件，Codex 连不上时也能恢复。
  - 插件被移除或关掉却没先停用：macOS、Linux 上引擎会恢复直连；Windows 上引擎随插件服务一起结束（Codex 的 Job 限制），只能靠停用或卸载命令。面板、插件说明和 README 都写了“先停用再移除”。
  - 顺手修复：引擎的工作目录不再是插件目录；面板开发页的导入路径，以及它改用临时 Codex 目录。
- [ ] **v0.1-6 在 GitHub 上发布 v0.1**：Release 工作流已备好（`.github/workflows/release.yml`：推 `v0.1.0` 标签后先跑三个平台的 CI，再建草稿 Release，附带写好版本号的四个安装、卸载脚本，说明取自 `CHANGELOG.md`）。发布前还差最后一步【需用户】：README、演示视频、截图、仓库目录结构调整；仓库改成公开。
- [x] **v0.1-7 许可证和 CI**（用户 2026-09-25 定：MIT，并加上 CI）：`LICENSE`（插件目录里也放一份）；`.github/workflows/ci.yml` 在 Windows、macOS、Linux 上跑单元测试；问题反馈模板，方便 macOS、Linux 用户在 GitHub 上报问题。
- 待定：Windows 上不先停用就移除插件，Codex 会断连，只能靠卸载命令恢复；要不要用计划任务让引擎不依赖插件启动，见 spec.md 第 5 节。

---

## 打包 P5

设计见 plan.md 第 13 节。

- [x] **面板补充：发送预览和改写失败提示**（2026-09-25，用户要求；spec.md 第 4 节“首版”第 4、6 条）
  - 引擎分开记“最近一次事件”和“最近一次完整请求”（带每张图的大小），WebSocket 在取消后仍在传数据时记一笔（`plugin/src/request-stats.ts`、`proxy.ts`）。
  - 面板顶部：下一条消息发送几张、占位几张，预计请求大小和全部发送的对比，上一次请求实际少发多少；两类提示（`panel-state.ts`、`panel.html`）。新增 4 个单元测试。
- [x] **P5-1 查证插件格式和安装方式**：插件清单、`.mcp.json`、插件市场清单、Codex 命令行的 `plugin marketplace add` / `plugin add` / `plugin remove`、插件缓存位置、Codex 自带的 Node 24（结果见 plan.md 第 13 节）。
- [x] **P5-2 打包**：运行代码搬进 `plugin/src`；`plugin/.codex-plugin/plugin.json`（名称、说明、图标）、`.mcp.json`、`scripts/launch.cmd`；仓库根目录的 `.agents/plugins/marketplace.json`；`cam.cmd` 不用另装 Node 就能运行命令行。
- [x] **P5-3 安装和卸载改成插件方式**（`cam.ts`、`install.ts`、`codexcli.ts`；共 79 个单元测试）
  - install：检查冲突 → 备份 → 登记市场 → 装插件 → 自检装好的副本 → 写代理设置 → 迁移旧勾选 → 确保引擎在运行。
  - uninstall：先恢复直连，再卸插件、去掉市场。数据目录改到 `%LOCALAPPDATA%\codex-attachment-manager`。
  - 2026-09-25 在用户机器上安装成功：插件进了 Codex 缓存，自检通过，旧版写的服务块已去掉，迁移了 6 份勾选记录。
- [x] **P5-4 README**：用途、原理、安装、使用、卸载（强调要用 `cam uninstall`）、限制、数据和隐私、开发。
- [ ] **P5-5 桌面版端到端验证**【需用户】：重启 Codex → 插件页面能看到插件 → 从侧边面板打开面板、看发送预览 → 取消一张图再问一次 → 日志确认插件服务从 Codex 的缓存启动、引擎由它拉起。

---

## 已完成：界面 P4

设计见 plan.md 第 12 节，结果见 `docs/p4-report.md`。

- [x] **P4-1 找入口**（2026-09-24；依据：桌面版 26.917 的前端代码）：工具在 `_meta["openai/ui"].entrypoints` 里声明 `thread` 入口后，面板出现在右侧侧边面板“新建标签页 → 插件和 MCP”里，用户手动打开，不经过模型；打开后桌面版用当前任务的编号调用工具。标题栏没有给插件的入口，所以不做外挂窗口。
- [x] **P4-2 面板**（`panel.html`，`plugin-server.ts` 的 `cam_panel` / `cam_image`，`panel-state.ts`，P5 起都在 `plugin/src`；开发页 `spike/scripts/panel-dev.ts`；新增 3 个单元测试，共 73 个）
  - 按轮次列出任务历史里的图片，缩略图、编号、名称、来源、尺寸、大小；点缩略图放大预览；勾选先暂存，点“确定”才保存。
  - 标出“不发送”、“由 IMG-xxx 代替”、“与 IMG-xxx 相同”、“模型需要这张”、“无法取消”；代理没在运行时提示。
  - 主题、字体、配色跟随 Codex；每 3 秒刷新，新图自动出现。
- [x] **P4-3 桌面版实测**【需用户】（2026-09-24 通过；证据：`local/plugin-server.jsonl`、`local/proxy/2026-09-24.jsonl`、用户截图；结果见 `docs/p4-report.md`）
  - 从“插件和 MCP”打开面板，数据、缩略图、主题都对；面板的调用没有写进聊天记录。
  - 预览、勾上 a.png、点“确定”后，下一次请求带上两张图、不做替换，模型答出了 a.png 的背景、形状和角标。
---

## 已完成：核心完善 P3

设计见 plan.md 第 11 节，验收标准见 spec.md 第 4 节“首版”。

- [x] **P3-1 试验面板**【需用户】（2026-09-24 通过；证据：`local/p3/panel-probe.jsonl`、用户截图；结果见 plan.md 第 11 节）
  - 面板能在桌面版右侧侧栏显示；握手、回调、data URL 小图都正常；访问 `localhost` 被拦截。
  - 插件服务按会话启动；工具要靠模型搜索才能找到，所以面板不能靠模型打开。
  - 配置已恢复（`mcp-disable`）。
- [x] **P3-2 引擎**（`spike/src/engine.ts`、`proxy.ts`、`paths.ts`；5 个单元测试）：全机单实例；`ensure` 在后台拉起；Codex 全部退出后自动退出；每个任务最近一次请求的统计写进状态文件。
- [x] **P3-3 插件服务**（`spike/src/plugin-server.ts`、`panel-state.ts`、`thumbnail.ts`；13 个单元测试）：启动时和每 3 秒确保引擎在运行；给面板的数据工具（图片列表、缩略图、勾选和取消、上次请求统计、模型索要的编号）；模型发起的勾选一律拒绝。
- [x] **P3-4 安装和恢复命令**（`spike/src/install.ts`、`cam.ts`；5 个单元测试）：`install` / `uninstall` / `status`；冲突时什么都不写。
- [x] **P3-5 稳定性自测**（证据：`local/p3/selftest-run2.json`、`local/p3/lifecycle.json`；结果见 `docs/p3-report.md`）：7 项检查全部通过。引擎会随拉起它的插件服务实例一起结束，最多断开 3 秒后由其他实例重新拉起。“Codex 全部退出后引擎自动退出”要等用户关掉桌面版时实测。
- [x] **P3-6 装进桌面版实测**【需用户】（2026-09-24 通过；证据：`local/plugin-server.jsonl`、`local/proxy/2026-09-24.jsonl`；结果见 `docs/p3-report.md` 第 6 节）
  - `cam.ts install` 后，重启 Codex，插件服务自动拉起引擎；取消 a.png 后，下一轮被改写，模型回复“需要 IMG-002”。
  - 两种退出都实测过：安装时启动的引擎，在 Codex 关闭后自己退出；插件服务拉起的引擎，随 Codex 一起结束。
  - Codex 启动的头 40 秒里，引擎来回重启了 4 次（已知限制），当时没有对话，没有影响。
---

## 已完成：代理验证 P2（按勾选改写）

设计见 plan.md 第 10 节，验收标准见 spec.md 第 4 节“代理路线 P2”。

- [x] **P2-1 请求结构**（证据：`local/p2/requests/`、`local/p2/capture-run1.json`）
  - 代理加上 `--force-http` 和 `--dump-requests` 两个选项。
  - 用合成图片跑一遍上传、工具查看、生图，确认图片在请求里的位置、条目 `id` 和轮次信息，以及 426 之后 Codex 是否改走 HTTP。
- [x] **P2-2 识别与编号**（`spike/src/images.ts`、`spike/src/thread-index.ts`；8 个单元测试）
  - 从请求或本地记录里找出每张图，得到识别键、类型、名称、尺寸和内容哈希。
  - 按记录顺序编号；增量读取记录；处理分页记录的衔接。
- [x] **P2-3 改写规则**（`spike/src/rewrite.ts`；7 个单元测试）
  - 覆盖：普通占位符和重复占位符；两个方向的副本；全部副本都取消；像素相同；托管生图结果锁定；同样的勾选得到同样的文字。
- [x] **P2-4 接入代理**（`spike/src/proxy.ts`、`spike/src/selection.ts`、命令行 `spike/src/cam.ts`；3 个单元测试）
  - 有取消项的任务：握手回 426，空闲的 WebSocket 连接关掉，HTTP 请求改写后重新压缩。
  - 不能安全改写时原样转发，并记下原因。
- [x] **P2-5 自测**（证据：`local/p2/selftest-run2.json`；10 项检查全部通过，见 `docs/p2-report.md`）
  - 我们自己启动的 app-server，环境和桌面版一致，在同一个任务里走完上传、取消、询问、重新勾选、再询问、全部勾选。
  - 另外用阶段 0 的真实样本（原任务和 fork，只读）测了耗时，并修好了读不到分叉任务的问题（证据：`local/p2/bench-*.json`；`spike/src/p2-bench.ts`）。
- [x] **P2-6 桌面版验证**【需用户】（2026-09-24 通过；证据：`local/proxy/2026-09-24.jsonl` 和测试任务的本地记录；结果见 `docs/p2-report.md` 第 5 节）
  - 打开配置（`config.toml` 加 `.env`）、启动代理，用户重启桌面版。
  - 在一个测试任务里上传几张图并发一轮；用命令行取消其中一张和一个副本；用户询问这两张图，确认模型索要原图、按副本指向的那一张回答，而且对话照常显示；重新勾选后再问一次。
  - 生图、改图各一次，确认请求经过代理。
  - 结束后恢复配置、停止代理。
- [x] **P2-7 报告**（`docs/p2-report.md`）

---

## 已完成：代理验证 P1（只转发、不改写）

设计见 plan.md 第 9 节。

- [x] **P1-1 配置工具**（`spike/src/codexconfig.ts`，7 个单元测试）
  - 自动定位 Codex 目录，提供 enable、disable、status 三个命令。
  - 修改前备份；只增删带标记的那一段；如果已经有用户自己的 `openai_base_url`，不覆盖。
  - 单元测试覆盖：插入位置在所有表头之前、CRLF 和 BOM、重复启用、恢复后逐字节一致、冲突检测。
- [x] **P1-2 透明代理**（`spike/src/proxy.ts`，4 个单元测试；自动识别出系统代理，未登录请求得到上游预期的 401）
  - HTTP 请求和 WebSocket 连接原样转发；自动沿用系统代理；只在 `127.0.0.1` 上监听。
  - 日志只记元数据，不含认证信息和对话内容。
- [x] **P1-3 自测（不改配置）**（证据：`local/p1-selftest.json`、`local/proxy/*.jsonl`）
  - 我们自己启动的 app-server 用 `-c openai_base_url` 指向代理，依次验证文字、附图、生图、改图都能成功，日志里能看到对应的请求。
- [x] **P1-4 桌面版验证**【需用户】（文字、上传图片、按任务区分在 P1 通过；生图和改图在 P2-6 里通过，靠的是 `.env` 里的 `NO_PROXY`，不用等上游 #47742，见 `docs/p2-report.md`）
  - 修改桌面版的配置（先备份）。用户重启桌面版后，在任务里依次发文字、上传图片、让它生图、让它改图。
  - 通过代理日志确认这些请求全部经过代理并且成功，不同任务的请求带着各自的任务 ID。
- [x] **P1-5 收尾**（配置已恢复且不留标记，代理已停止；报告：`docs/p1-report.md`）
  - 按用户的决定恢复或保留配置；写 `docs/p1-report.md`（只写统计）。

---

## 已完成：阶段 0 技术验证

> 验收关卡见 [spec.md](spec.md) 第 4 节。

## 执行规则

- 代码放在 `spike/` 下。每个脚本开头用注释写明用途、输入和输出。这是一次性的验证代码，不追求产品化，但必须遵守只读规则。
- 从真实会话里提取的图片、记录片段、日志和备份，只放在 `local/`（已被 git 忽略），不提交。
- 标了【需用户】的步骤，要由用户在桌面版上操作或做判断。走到这一步先停下，说清楚需要用户做什么。
- 遇到 plan.md 没有覆盖的决策，停下来写进报告，交给用户决定。这类决策包括：改变路线、扩大范围、需要直接写入 `~/.codex`、需要修改用户配置。
- 其他协作者不修改 `docs/spec.md` 和 `docs/plan.md`（由 Claude 维护，见 AGENTS.md）。发现需要修改的地方，写进报告。

## 任务

- [x] **T0 准备**（证据：`spike/package.json`、`spike/tsconfig.json`、`local/phase0-report-draft.md`、`local/protocol-types/`）
  - 在 `spike/` 下初始化 TypeScript/Node 工程。
  - 记录桌面版版本，以及桌面版自带的 `codex.exe` 的路径和版本。路径写成 `%LOCALAPPDATA%\…` 这样的通用形式。
  - 确认样本任务（原任务和 fork）的线程 ID，以及它们的历史存在 JSONL 里还是 SQLite 里。
  - 用 `codex app-server generate-ts` 生成本机的协议类型。
  - 完成标准：以上信息都写进报告草稿。

- [x] **T1 只读导入**（关卡 1；证据：`local/assets.json`、`local/assets.md`、`local/phase0-report-draft.md`）
  - 读取样本的记录，输出一份素材清单，同时给出 JSON 和便于阅读的表格。每条出现记录包括：轮次、时间、来源类型、字节数、字节哈希、像素哈希、尺寸、已知的本地路径。
  - 标出重复关系，无法识别的项单独列出。
  - 操作前后，对样本的记录文件分别计算哈希并对比。
  - 完成标准：满足 spec 关卡 1。

- [x] **T2 找到磁盘上的原件**（证据：`local/matches.json`、`local/matches.md`、`local/cache/`）
  - 在样本任务所用的项目素材文件夹（包括子目录；位置执行者已知，不写进仓库）和 `generated_images/` 里，按哈希找每份素材的原件。
  - 如果 Codex 发送前缩放过图片，导致哈希对不上，记下有多少张。然后把图片缩放到相同尺寸再比较相似度，给出候选匹配，标为“待确认”。
  - 统计“找到原件”和“只存在于记录里”各有多少。后者解码后缓存到 `local/`。
  - 完成标准：每份素材都有一个可以当附件用的本地文件。

- [x] **T3 连上 app-server**（证据：`local/t3-connect.json`、`local/sqlite-backup/`；由 Claude 执行）
  - 按 plan“安全措施”备份 SQLite 状态库。
  - 用桌面版自带的 `codex.exe` 启动一个独立的 app-server（stdio），完成 `initialize`，再调用只读的 `thread/list`。
  - 如果被沙箱拦下，请用户批准提权，或者请用户在普通终端里运行。
  - 完成标准：能列出样本任务。

- [x] **T4 重建**（证据：`local/rebuild-preview.json`、`local/t4-rebuild.json`；由 Claude 执行）
  - 按 plan“搬迁规则”生成要注入的条目。
  - 新建任务，命名为 `[CAM测试] <原任务名>`。勾选 1–2 张图（例如 B），发一轮简短的请求，同时记录请求字节数。
  - 桌面版全程开着（这就是真实的使用场景），记录有没有出现写锁冲突或报错。
  - 完成标准：
    - 新任务正常回复；
    - 拿到请求字节数；
    - 报告里写明注入了哪些条目、搬的是哪一段历史。

- [x] **T5 可见、可续**（关卡 2）【需用户】（用户 2026-09-24 确认：能打开、能继续、重启后仍在）
  - 先结束我们的 app-server，再请用户在桌面版里打开新任务并继续对话，然后重启桌面版，确认任务还能恢复。

- [x] **T6 改图与重新勾选**（关卡 3）【需用户】（证据：`local/turn-t6-reselect.json`、`local/turn-t6-edit.json`；Claude 已对照原图核对，用户 2026-09-24 确认画面）
  - 在新任务里，让模型基于选中的图，用内置生图继续修改。
  - 找一张之前取消了的图（例如 A），在下一轮重新勾选并作为附件带上，检查模型能否正确描述和使用它。
  - 完成标准：满足 spec 关卡 3。报告附上相关的工具调用记录，画面由用户确认。

- [x] **T7 未选不发送、请求变小**（关卡 4、5；证据：`local/t7-calibration.json`、`local/t7-measure.json`；由 Claude 执行）
  - 按 plan“测量方法”检查新任务的历史和请求。
  - 完成标准：满足 spec 关卡 4、5，并给出与 43.8 MB 基线的对比。

- [x] **T8 占位符有效**（关卡 6；证据：`local/turn-t8-placeholder.json`；由 Claude 执行）
  - 针对一张没有提供的图，询问画面细节，检查模型怎么回答。
  - 完成标准：满足 spec 关卡 6，报告里摘录这段问答。

- [x] **T9 附加实验**（不算关卡，只记录结果；证据：`local/probe-t9a-no-view-image.json`、`local/probe-t9b-mcp-meta.json`、`local/mcp-probe.jsonl`、`local/handoff/`；由 Claude 执行）
  - a. 关掉 `view_image` 后，整个流程是否还能用（plan 第 4 节）。
  - b. 如果能通过配置覆盖临时挂一个测试用的 stdio MCP 服务，记录它收到的调用里 `_meta` 有哪些内容。做不到就跳过，不要为此修改用户配置。
  - c. 生成一份路线 B 的交接包，记录手动继续需要哪些步骤、体验如何。

- [x] **T10 报告**（`docs/phase0-report.md`；关卡 2 的结果待用户完成 T5 后补上）
  - 写 `docs/phase0-report.md`，内容包括：
    - 环境和版本；
    - 每个关卡的结果（通过或失败）和证据；
    - 实测数字；
    - 发现的问题和风险；
    - 按 plan“怎么选”给出的路线建议；
    - 需要用户决定的事项。
  - 报告里不贴原任务的图片和对话原文，也不写本机的具体路径，只写统计和必要的简短摘录。测试任务里的问答可以摘录。
  - 写完就停下，不要进入首版开发。
