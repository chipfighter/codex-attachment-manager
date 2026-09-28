# Codex 上下文素材管理器（Codex Attachment Manager）

[English](README.md) · **简体中文**

一个 Codex 桌面版插件：在同一个任务里，逐轮决定哪些历史图片随下一条消息发给模型。

## 它解决什么问题

在 Codex 里做设计、改图、看截图，一个任务里的图片会越积越多。之后每一次请求，都会把这些图重新发给模型：请求越来越大，越来越慢，也越来越贵。想去掉旧图，原本只能新开任务，前面的对话就接不上了。

装上这个插件后：

- Codex 右侧的侧边面板里多出一个“上下文素材”标签页，按时间顺序列出这个任务里的全部图片：你上传的，以及模型查看、生成的。
- 取消勾选的图，从下一条消息起换成一小段占位文字。如果有内容相同的图还在发送，占位文字会指向那一张。任务不换，对话连续。
- 模型知道那些图是你为了节省上下文省略的：它之前看着原图给出的回答仍然算数，不会因此改口，也不会编造没看到的细节。需要某张图时，它会回复“需要 IMG-xxx”，给不给由你在面板里决定。
- 面板顶部显示下一条消息会发送什么，以及请求大约能小多少。

## 工作原理

- 插件在本机启动一个小代理（引擎），Codex 发往 OpenAI 的请求先经过它。
- 你取消勾选的图，在请求发出前被换成占位符，并附上一条说明，告诉模型这些图是你省略的；其余内容原样转发。
- 勾选状态按任务分别保存，只有你能改，模型不能。
- 面板是 Codex 的插件页面，从侧边面板手动打开，不经过模型，也不花 token。

## 环境要求

- Codex 桌面版。Windows 上在 26.924 上实测过。
- macOS、Linux：CI 上验证过 Codex 能装上插件、启动插件服务和引擎，安装和卸载命令也能正常工作；但还没有人在这两个平台的桌面版上实测过。遇到问题请[提 issue](https://github.com/chipfighter/codex-attachment-manager/issues)。
- 不需要另外安装 Node：插件使用 Codex 自带的 Node 24；找不到时，才用系统里 24 以上的 `node`。

## 安装

### 方式一：在 Codex 里安装，不用开终端

1. 打开 Codex 的插件页面，点“添加插件市场”。
2. “来源”填 `chipfighter/codex-attachment-manager`，其余留空，点“添加市场”。
3. 在插件列表里找到“上下文素材管理器”，安装。
4. 打开一个任务，点右上角“显示/隐藏侧边面板”，再点“新建标签页”，在“插件和 MCP”下选“上下文素材”。找不到的话，先重启一次 Codex。
5. 面板顶部会提示“还没有接入 Codex”。点“启用”，然后**重启 Codex**。

### 方式二：一行命令

Windows（PowerShell）：

```powershell
irm https://github.com/chipfighter/codex-attachment-manager/releases/latest/download/install.ps1 | iex
```

macOS、Linux：

```bash
curl -fsSL https://github.com/chipfighter/codex-attachment-manager/releases/latest/download/install.sh | sh
```

命令会用 Codex 自己的命令行装好插件，并写好代理设置。装完**重启 Codex**。以后再运行一次，就是升级到最新版本。

### 安装会改什么

- 在 `~/.codex/config.toml` 里写一段带标记的代理设置，改之前先备份到数据目录。
- 如果你的环境变量里设了代理，还会在 `~/.codex/.env` 里写一段 `NO_PROXY`，只包含本机地址。
- 别的设置一概不动。如果你自己已经设了 `openai_base_url`，安装会停下来，什么都不写。

## 使用

1. 打开一个任务，在侧边面板里打开“上下文素材”（位置见上面安装的第 4 步）。面板左上角显示任务名。新任务也可以在发第一条消息之前打开：发出第一条消息后，面板会自动切到这个任务。
2. 取消勾选不想再发送的图（点缩略图可以看大图），点一下就保存，从下一条消息起生效。每一轮标题右侧的勾选框可以整轮勾上或取消。
3. 模型回复里说“需要 IMG-xxx”、而那张图没勾上时，面板页头会出现“模型需要 N 张没发送的图”。点编号就跳到那张图，勾上它，下一条消息就会带上它。

面板里的标签：

| 标签 | 含义 |
|---|---|
| 不发送 | 换成普通占位符 |
| 由 IMG-xxx 代替 | 有内容相同的图还在发送，占位符会指向它 |
| 与 IMG-xxx 相同 | 这两张图内容相同 |
| 模型需要这张 | 模型上一次回复说了“需要 IMG-xxx” |
| 已不在上下文 | 这张图已被 Codex 压缩出历史，不会再发送 |
| 无法取消 | Codex 自带生图工具的结果，格式上不能替换 |

## 卸载

**先停用，再移除**：在面板标题右侧点“停用”并确认，然后在插件页面移除插件，重启 Codex。

也可以用一行命令，它会恢复直连，并移除插件：

Windows（PowerShell）：

```powershell
irm https://github.com/chipfighter/codex-attachment-manager/releases/latest/download/uninstall.ps1 | iex
```

macOS、Linux：

```bash
curl -fsSL https://github.com/chipfighter/codex-attachment-manager/releases/latest/download/uninstall.sh | sh
```

勾选记录和日志留在数据目录里（见下面“数据和隐私”），不需要可以删掉。

## Codex 连不上怎么办

如果没先停用就移除了插件，或者引擎没能启动，Codex 会报错，错误里带着 `localhost:17891`。这时运行上面的卸载命令，再重启 Codex，就能恢复直连。卸载命令不需要插件的文件，插件删掉了也能用。

macOS、Linux 上，插件被移除或关掉后，引擎会自己恢复直连，下次启动 Codex 时生效。

## 已知限制

- 目前只管理图片，其他类型的文件以后再支持。
- Codex 自带生图工具的结果不能取消。
- 取消勾选时，如果这一轮对话还在进行，并且走的是 WebSocket，这一轮剩下的请求仍会带着原图。面板会提示，从下一条消息起生效。
- 启用、停用和升级，都要重启 Codex 才生效。
- 切换 Codex 的界面语言后，侧边面板里入口的名字要重启 Codex 才会跟着变；面板里的文字马上就换，发给模型的说明从下一条消息起换。
- Codex 刚启动的头几十秒里，引擎可能会重启几次，偶尔会看到一次“正在重新连接”。
- 引擎沿用系统代理：Windows 读系统设置，macOS 只认 HTTP(S) 代理（不支持 PAC 和 SOCKS），Linux 读 `HTTPS_PROXY` 等环境变量。

## 数据和隐私

- 所有数据只留在本机的数据目录：Windows 是 `%USERPROFILE%\.codex-attachment-manager`，macOS 是 `~/Library/Application Support/codex-attachment-manager`，Linux 是 `~/.local/share/codex-attachment-manager`。里面有：
  - 勾选记录；
  - 请求统计：只记大小和数量，不记内容；
  - 日志：不记对话内容和凭据；
  - `config.toml` 的备份。
- 除了 Codex 本来就要发给 OpenAI 的请求，插件不向任何地方发送数据。
- 原始对话记录只读，不修改。

## 开发

- 插件本体在 `plugin/`；`spike/` 里是测试和早期实验脚本；`scripts/` 里是一行命令用的安装、卸载脚本。
- 从源码装进自己的 Codex：在仓库里运行 `cam install`（macOS、Linux 上是 `./cam install`），卸载用 `cam uninstall`，`cam status` 查看安装状态。
- 运行测试：`cd spike && node --test`。CI 在 Windows、macOS、Linux 上跑全部单元测试，再用 Codex 自己的命令行真的装一遍插件、跑一遍安装和卸载脚本。
- 不开 Codex 调面板：`node spike/scripts/panel-dev.ts`，然后在浏览器里打开 `http://127.0.0.1:17895/?solo=1`。页面用合成的测试图和一个临时的 Codex 目录，不读取、不修改你的真实数据。
- 规格、方案和各阶段报告在 `docs/` 下，从 [docs/spec.md](docs/spec.md) 读起。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
