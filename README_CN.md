<p align="center">
  <img src="plugin/assets/logo.png" width="96" height="96" alt="">
</p>

<h1 align="center">Context Attachment Manager</h1>

<p align="center">在 Codex 和 Claude 桌面版里，不换对话，决定哪些历史图片随下一条消息发给模型。</p>

<p align="center">
  <a href="https://github.com/chipfighter/context-attachment-manager/actions/workflows/ci.yml"><img src="https://github.com/chipfighter/context-attachment-manager/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/chipfighter/context-attachment-manager/releases"><img src="https://img.shields.io/github/v/release/chipfighter/context-attachment-manager?include_prereleases" alt="版本"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="平台：Windows、macOS、Linux">
  <img src="https://img.shields.io/badge/Codex%20desktop-26.924-339CFF" alt="在 Codex 桌面版 26.924 上实测">
  <img src="https://img.shields.io/badge/Claude%20Desktop-Claude%20Code%202.1.295-D97757" alt="在 Claude 桌面版（Claude Code 2.1.295）上实测">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="许可证：MIT"></a>
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

> **0.4 新增：Claude 桌面版也能用了。** 在 Claude 桌面版的 Code 标签页装上插件，在会话里输入 `/cam`，同一个面板就在 Claude 桌面版自带的浏览器里打开，就在对话旁边。项目原名 *Codex Attachment Manager*，因为不再只给 Codex 用，改了名。

<p align="center">
  <img src="docs/images/demo.gif" alt="面板的筛选先只显示 PDF 页面，再恢复显示全部，上传的图按整轮取消勾选。问起 v1 桌面版的聊天按钮，模型回复 need IMG-001；面板指出 IMG-001，用户勾上它，模型看图答出橙色。" width="100%">
</p>

## 为什么做这个

我在 Codex 里用 GPT 反复生图、改图。图攒到十几张以后，这个任务开始出问题：连接一直断，每隔几分钟自动重试一次，始终发不出去。查下去发现，Codex 每次请求都会把任务历史里的图全部重新发一遍，一次请求已经涨到约 44 MB。想去掉旧图只能新开任务，前面的对话就接不上了。

所以我想要的是：长对话照常继续，每一轮自己决定模型还能看到哪些图。不再需要的图取消勾选，从下一条消息起换成一小段占位文字，任务不换，对话连续。Claude Code 每次请求也会把整段历史发一遍，所以 0.4 把同一个面板带到了 Claude 桌面版。

## 功能

- **所有图片一个列表**：面板按轮次列出任务（Codex）或会话（Claude Code）里的每张图，包括你上传的，以及模型查看、生成的，带缩略图、编号和大小，点开可以看大图。在 Codex 里，它是侧边面板里的“上下文素材”标签页；在 Claude 桌面版里，用 `/cam` 在自带的浏览器里打开。
- **按来源筛选**：图多的时候，只看某几类：你上传的、在 Codex 里批注 PDF 时附上的页面（标出第几页和 PDF 文件名）、网页截图，以及模型查看的、工具返回的、生成的。筛选只改变面板里显示哪些，不影响发送。
- **点一下就不再发送**：取消勾选的图，从下一条消息起换成一小段占位文字。可以单张勾选，也可以整轮勾选。
- **重复的图自动处理**：有内容相同的图还在发送时，占位文字指向那一张。
- **模型知道原因**：一段说明告诉模型，这些图是你为了节省上下文省略的。它之前看着原图给出的回答仍然算数，也不会编造看不到的细节。
- **模型要图，你来决定**：模型需要某张图时，会回复“需要 IMG-xxx”。面板列出它要的图，点一下就跳过去。重新勾上的图回到对话里原来的位置，并标着编号。
- **也可以交给模型选**（0.3 新增）：在面板底栏打开“自动选图”，每个任务或会话各开各的。之前各轮的图默认不发，模型需要哪张，就按编号取回，只在那一轮提供；勾上的图固定发送，每轮都发。面板会标出模型最近一轮取回了哪几张。
- **看得见省了多少**：面板预估下一条请求的大小，以及比全部发送省了多少；请求没能改写时会提示。
- **中英文界面**：面板、标签页名字和给模型的说明，都跟随 Codex 的界面语言（简体中文、英文）；没装 Codex 时跟随系统语言。
- **数据留在本机**：除了 Codex 和 Claude Code 本来就要发给 OpenAI、Anthropic 的请求，插件不向任何地方发送数据。

## 工作原理

- 插件在本机启动一个小代理（引擎），位于 Codex 和 OpenAI、Claude Code 和 Anthropic 之间。请求发出前，引擎把取消勾选的图换成占位文字，并加上那段说明；其余内容原样转发，登录凭据也原样转发。
- 在 Codex 里，安装时把 Codex 指向引擎。在 Claude 桌面版里，插件在每个 Claude Code 会话启动时把它指向引擎，会话结束时还原。
- 开着自动选图时，引擎对之前各轮没有固定发送的图也这样处理；插件给模型一个工具 `cam_view_image`，用来把某张图取回到当前这一轮。前面的占位文字保持不变，请求里已经缓存的部分不受影响。
- 勾选状态和自动选图开关按任务或会话分别保存，只有你能改；模型只能在开着自动选图时，取回某张图在那一轮看。
- 面板不经过模型，也不花 token。在 Codex 里它是侧边面板里的 MCP 应用；在 Claude 桌面版里，由引擎把同一个页面提供给自带的浏览器，只在本机访问。

## 环境要求

- **Codex**：Codex 桌面版。在 Windows 上用 Codex 26.924 实测过。
- **Claude 桌面版**：Code 标签页里的本地会话，用你的 Claude 订阅登录。在 Windows 上实测过，Claude 桌面版运行的是 Claude Code 2.1.295。
- macOS、Linux：CI 会用 Codex 自己的命令行装上插件、启动插件，并跑一遍安装和卸载脚本；但还没有人在这两个平台的桌面版上实际用过。遇到问题欢迎[提 issue](https://github.com/chipfighter/context-attachment-manager/issues)。
- Node：插件使用 Codex 自带的 Node 24；找不到时，才用 PATH 里 24 及以上版本的 `node`。Claude 桌面版不带 Node，没装 Codex 的话，请装 [Node 24 或更新版本](https://nodejs.org)。

## 安装

### 在 Codex 里安装，不用开终端

1. 在 Codex 的**插件**页面点**添加插件市场**，**来源**填 `chipfighter/context-attachment-manager`，其余留空，点**添加市场**。
2. 在列表里找到 **Context Attachment Manager**，安装。
3. 打开一个任务，点右上角的**显示/隐藏侧边面板**，用 **+** 新建一个标签页，在**插件和 MCP**下选**上下文素材**。找不到的话，先重启一次 Codex。
4. 面板提示插件还没有启用。点**启用插件**，然后重启 Codex。

### 在 Codex 里用一行命令安装

Windows（PowerShell）：

```powershell
irm https://github.com/chipfighter/context-attachment-manager/releases/latest/download/install.ps1 | iex
```

macOS、Linux：

```bash
curl -fsSL https://github.com/chipfighter/context-attachment-manager/releases/latest/download/install.sh | sh
```

命令会用 Codex 自己的命令行装好插件，并写好代理设置。装完重启 Codex。以后再运行一次，就是升级到最新版本。

安装会在 Codex 里改这些：

- 在 `~/.codex/config.toml` 里写一段带标记的代理设置，改之前先备份。
- 如果环境变量里设了代理，再在 `~/.codex/.env` 里写一段带标记的 `NO_PROXY`，只包含本机地址。
- 别的一概不动。如果你自己设了 `openai_base_url`，安装会停下来，什么都不写。

### 在 Claude 桌面版里安装

Claude 桌面版只能从已经添加的插件市场安装插件，而从 GitHub 添加插件市场要用 Claude Code 的命令行 `claude`（[安装说明](https://code.claude.com/docs/en/setup)）。只需要做一次：

```bash
claude plugin marketplace add chipfighter/context-attachment-manager
```

```bash
claude plugin install codex-attachment-manager@codex-attachment-manager
```

第二条命令也可以换成在 Code 标签页里装：点输入框旁边的 **+**，选**插件**，再选**添加插件**，找到 **Context Attachment Manager**，装到你的用户账户下。安装用的标识还是项目原来的名字。

然后在 Code 标签页里新建一个会话。不用做任何设置：插件不改任何设置，只在会话运行期间把这个会话自己的 Claude Code 进程指向引擎。

## 使用

### 在 Codex 里

1. 在任务的侧边面板里打开**上下文素材**。新任务也可以在发第一条消息之前打开：发出消息后，面板会自动切到这个任务。
2. 取消勾选不想再发送的图。每次改动立刻保存，从下一条消息起生效。
3. 模型回复“需要 IMG-xxx”、而那张图没有勾上时，面板顶部会列出它。点编号跳到那张图，勾上即可。
4. 图多的时候，点刷新旁边的筛选按钮，选要看的来源。这时整轮勾选只管显示出来的图。
5. 想交给模型选，就打开面板底栏的**自动选图**。勾上每轮都要发的图，比如一直要对照的参考图；其余的由模型需要时自己取回。关掉开关，你原来的勾选原样回来。

### 在 Claude 桌面版里

1. 在 Code 标签页的会话里输入 `/cam` 并发送，面板就在 Claude 桌面版自带的浏览器里打开，就在对话旁边。如果 `/cam` 是新会话的第一条消息，输入框可能提示命令不存在：照样发出去就行。Claude 桌面版在你发出第一条消息时才启动会话，插件这时才加上 `/cam`。
2. 之后的用法和 Codex 一样：取消勾选、重新勾上、按“需要 IMG-xxx”找图、筛选，或者打开**自动选图**。改动从下一条消息起生效。
3. 开着自动选图时，模型调用 `cam_view_image` 不会弹权限确认；你自己的 Claude Code 设置或钩子另有规定时，照它们的来。

用不了自带浏览器时（比如在终端里），`/cam` 会弹出一个小面板，给出面板的链接。

## 卸载

### Codex

先停用，再移除：在面板里点**停用插件**，在**插件**页面移除插件，然后重启 Codex。

也可以运行卸载命令。它会恢复直连并移除插件，插件文件已经删掉时也能用：

Windows（PowerShell）：

```powershell
irm https://github.com/chipfighter/context-attachment-manager/releases/latest/download/uninstall.ps1 | iex
```

macOS、Linux：

```bash
curl -fsSL https://github.com/chipfighter/context-attachment-manager/releases/latest/download/uninstall.sh | sh
```

**Codex 连不上时**：如果 Codex 的报错里带着 `localhost:17891`（比如没先停用就移除了插件），运行上面的卸载命令，再重启 Codex。macOS、Linux 上，插件被移除或关掉后，引擎也会自己恢复直连，下次启动 Codex 时生效。

### Claude 桌面版

在 Code 标签页里点 **+** → **插件** → **管理插件** 卸载，或者运行 `claude plugin uninstall codex-attachment-manager@codex-attachment-manager`。之后新建的会话直接连接，不用恢复什么。

勾选记录和日志留在数据目录里（见[隐私](#隐私)），不需要可以删掉。

## 一点补充

- 只管理图片，因为只有图片会原样发给模型。Codex 不发送 PDF 和视频文件本身，只发送模型从中提取的文字或转成的图片，这些图片会和其他图一起列出来。音频要等有能直接听音频的模型：在那之前，Codex 会在发送前把音频换成一句说明。
- Codex 自带生图工具的结果不能取消。
- 开着自动选图时，模型每取一张图，这一轮就多一次请求。小模型读取回的图可能读错小细节：测试里 GPT-6 Luna（低推理强度）偶尔会读错，用 Codex 自带的看图打开同一张图也一样；GPT-6 Sol 和 Astra 读得对。细节要紧的图可以固定发送，或者换用更大的模型。
- **2026 年 8 月 31 日及以后注册的 Claude 账号**，会核对模型之前的思考记录和它前面的对话是否一致。在这样的账号上省略一张图时，引擎会一起去掉和实际发出的对话对不上的那部分旧思考，所以模型可能要重新思考、多用一些 token，面板每次都会提示。改动之后新产生的思考会保留；把图勾回来，之前的思考也会放回去。更早注册的账号不受影响。
- 在 Claude Code 里只管理主对话，子代理的历史保持原样。改用了别的 API 地址或云服务（Bedrock、Vertex、Foundry）的会话不接管。
- 取消勾选时，如果 Codex 这一轮还在进行，并且走的是 WebSocket，这一轮剩下的请求仍会带着原图。面板会提示，从下一条消息起生效。
- 在 Codex 里，启用、停用和升级都要重启 Codex 才生效。在 Claude 桌面版里，新版本从新建的会话起生效；升级先运行 `claude plugin marketplace update codex-attachment-manager`，再运行 `claude plugin update codex-attachment-manager@codex-attachment-manager`。
- 切换 Codex 的界面语言后，面板立刻跟着换，给模型的说明从下一条消息起换；侧边面板里标签页的名字要重启 Codex 才换。
- Codex 刚启动时，引擎可能会重启几次，偶尔会看到一次“正在重新连接”。
- 引擎沿用系统代理：Windows 读系统设置；macOS 只支持 HTTP(S) 代理，不支持 PAC 和 SOCKS；Linux 读 `HTTPS_PROXY` 等环境变量。

## 隐私

- 所有数据只留在本机的数据目录：Windows 是 `%USERPROFILE%\.codex-attachment-manager`，macOS 是 `~/Library/Application Support/codex-attachment-manager`，Linux 是 `~/.local/share/codex-attachment-manager`。里面有勾选记录、请求统计（只记大小和数量，不记内容）、引擎用来判断哪些思考还对得上的哈希（不记内容）、日志（不记对话内容和凭据），以及 `config.toml` 的备份。
- 除了 Codex 和 Claude Code 本来就要发给 OpenAI、Anthropic 的请求，插件不向任何地方发送数据。
- Codex 和 Claude Code 的原始对话记录只读，不修改。

## 开发

- `plugin/` 是插件本体：MCP 服务、引擎、面板和 `cam` 命令行，运行代码在 `plugin/src`。Claude 插件是 `.claude-plugin/` 加上 `hooks/` 里的 Mod。`spike/` 是测试和实验脚本，`scripts/` 是一行命令用的安装、卸载脚本，`docs/` 是规格和技术方案，从 [docs/spec.md](docs/spec.md) 读起；v0.1 的开发记录在 `docs/history/v0.1/`。
- 从源码装进自己的 Codex：先退出 Codex，在仓库里运行 `cam install`（macOS、Linux 上是 `./cam install`），再启动 Codex。`cam status` 查看安装状态，`cam uninstall` 卸载。
- 运行测试（需要 Node 24 及以上）：`cd spike && node --test`。CI 在 Windows、macOS、Linux 上跑全部单元测试，再用 Codex 的命令行装一遍插件，跑一遍安装和卸载脚本。
- 不开 Codex 调面板：运行 `node spike/scripts/panel-dev.ts`，然后打开 `http://127.0.0.1:17895/?solo=1`。页面用合成的测试图和一个临时的 Codex 目录，不读取、不修改你的真实数据。
- 改了发给模型的文字（`plugin/src/rewrite.ts`）后，要跑 `spike/src/v01-placeholder-selftest.ts` 和 `spike/src/v01-needs-selftest.ts` 两个自测，改的是自动选图的文字时再跑 `spike/src/v03-auto-selftest.ts`，中文、英文（`--lang en`）各一次。它们会自己启动引擎和 app-server，使用你的 Codex 账号，测完把建的测试任务归档。
- 更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
