<p align="center">
  <img src="plugin/assets/logo.png" width="96" height="96" alt="">
</p>

<h1 align="center">Codex Attachment Manager</h1>

<p align="center">Choose which past images go to the model with your next message, without leaving the task.</p>

<p align="center">
  <a href="https://github.com/chipfighter/codex-attachment-manager/actions/workflows/ci.yml"><img src="https://github.com/chipfighter/codex-attachment-manager/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/chipfighter/codex-attachment-manager/releases"><img src="https://img.shields.io/github/v/release/chipfighter/codex-attachment-manager?include_prereleases" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform: Windows, macOS, Linux">
  <img src="https://img.shields.io/badge/Codex%20desktop-26.924-339CFF" alt="Tested on Codex desktop 26.924">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT"></a>
</p>

<p align="center"><b>English</b> · <a href="README_CN.md">简体中文</a></p>

<p align="center">
  <img src="docs/images/demo.gif" alt="Every image in the task is unchecked. Asked about v1's chat button, the model replies need IMG-002; the panel points to IMG-002, the user checks it, and the model answers from the image." width="100%">
</p>

## Why I built this

I was iterating on image generation with GPT in Codex. After a dozen or so images, the task started failing: the connection kept dropping, and the retries every few minutes never went through. Digging into it, I found that Codex sends every image in the task's history again with every request, and each request had grown to about 44 MB. The only way out was a new task, which meant losing the conversation.

So I wanted to keep the long conversation going and decide, turn by turn, which images the model still gets. Uncheck the ones you no longer need: from the next message on they become short placeholders, and the task and the conversation stay the same.

## Features

- **Every image in one list**: a *Context Assets* tab in Codex's side panel lists every image in the task, turn by turn: the ones you uploaded and the ones the model viewed or generated, with thumbnails, IDs and sizes. Click one to preview it.
- **One click to leave an image out**: unchecked images become a short placeholder from the next message on. Toggle single images or a whole turn.
- **Duplicates handled**: when an identical image is still being sent, the placeholder points to it.
- **The model knows why**: a note tells the model the images were left out by you to save context, so its earlier answers still stand and it doesn't make up details it can't see.
- **The model asks, you decide**: when it needs an image, it replies `need IMG-xxx`. The panel lists what it asked for and jumps to it in one click. A checked image goes back to its place in the conversation, marked with its ID.
- **See the savings**: the panel estimates the size of the next request and how much you save compared with sending every image, and warns you when a request could not be rewritten.
- **English and Simplified Chinese**: the panel, the tab name and the note for the model follow Codex's language.
- **Stays on your machine**: the plugin sends nothing anywhere besides the requests Codex already makes to OpenAI.

## How it works

- The plugin runs a small local proxy, the engine, between Codex and OpenAI. Before a request goes out, the engine swaps unchecked images for placeholders and adds the note; everything else is forwarded as is.
- Selections are saved per task. Only you can change them, not the model.
- The panel is an MCP app you open from the side panel. It doesn't go through the model and costs no tokens.

## Requirements

- Codex desktop app. Tested on Windows with Codex 26.924.
- macOS and Linux: CI installs the plugin with Codex's own CLI, starts it, and runs the install and uninstall scripts, but nobody has tried it in the desktop app on these platforms yet. [Issues](https://github.com/chipfighter/codex-attachment-manager/issues) welcome.
- No separate Node install: the plugin uses the Node 24 that ships with Codex, and falls back to `node` 24 or later on your PATH.

## Install

### In Codex, no terminal

1. On Codex's **Plugins** page, click **Add a marketplace**, enter `chipfighter/codex-attachment-manager` as the **Source**, leave the rest empty, and click **Add marketplace**.
2. Install **Codex Attachment Manager** from the list.
3. Open a task, click **Toggle side panel** at the top right, open a new tab with **+**, and choose **Context Assets** under **Plugins and MCPs**. If it isn't there, restart Codex once.
4. The panel says the plugin is not enabled yet. Click **Enable plugin**, then restart Codex.

### One command

Windows (PowerShell):

```powershell
irm https://github.com/chipfighter/codex-attachment-manager/releases/latest/download/install.ps1 | iex
```

macOS and Linux:

```bash
curl -fsSL https://github.com/chipfighter/codex-attachment-manager/releases/latest/download/install.sh | sh
```

The command installs the plugin with Codex's own CLI and sets up the proxy. Restart Codex afterwards. Run it again later to upgrade.

### What installing changes

- Adds a marked proxy block to `~/.codex/config.toml`, after backing the file up.
- If a proxy is set in your environment variables, adds a marked `NO_PROXY` block with local addresses only to `~/.codex/.env`.
- Nothing else. If you have set `openai_base_url` yourself, installing stops without writing anything.

## Usage

1. Open **Context Assets** in the side panel of a task. On a new chat you can open it before the first message; it switches to the task once you send.
2. Uncheck the images you don't want to send anymore. Each change is saved at once and applies from the next message.
3. When the model replies `need IMG-xxx` for an unchecked image, a bar at the top of the panel lists it. Click the ID to jump to the image and check it.

## Uninstall

Disable first, then remove: click **Disable plugin** in the panel, remove the plugin on the **Plugins** page, and restart Codex.

Or run the uninstall command. It restores the direct connection and removes the plugin, and it works even when the plugin files are gone:

Windows (PowerShell):

```powershell
irm https://github.com/chipfighter/codex-attachment-manager/releases/latest/download/uninstall.ps1 | iex
```

macOS and Linux:

```bash
curl -fsSL https://github.com/chipfighter/codex-attachment-manager/releases/latest/download/uninstall.sh | sh
```

Your selections and logs stay in the data folder (see [Privacy](#privacy)); delete it if you don't need them.

**If Codex can't connect** and its errors mention `localhost:17891` (for example, the plugin was removed without disabling it first), run the uninstall command above and restart Codex. On macOS and Linux the engine also restores the direct connection by itself once the plugin is removed or turned off, from the next start of Codex.

## Good to know

- Only images are managed for now; other file types may come later.
- Results of Codex's built-in image generation can't be unchecked.
- If you uncheck an image while a turn is still running over WebSocket, the rest of that turn still carries the original. The panel tells you; the change applies from the next message.
- Enabling, disabling and upgrading take effect after you restart Codex.
- After you switch Codex's language, the panel changes right away and the note for the model changes from the next message, but the tab name in the side panel changes only after a restart.
- Right after Codex starts, the engine may restart a few times and you may see "Reconnecting" once.
- The engine goes through your system proxy: on Windows it reads the system setting, on macOS it supports HTTP(S) proxies only (no PAC or SOCKS), and on Linux it reads `HTTPS_PROXY` and similar variables.

## Privacy

- All data stays in a local folder: `%USERPROFILE%\.codex-attachment-manager` on Windows, `~/Library/Application Support/codex-attachment-manager` on macOS, `~/.local/share/codex-attachment-manager` on Linux. It holds your selections, request statistics (sizes and counts only, never content), logs (no conversation content or credentials) and the backup of `config.toml`.
- Besides the requests Codex already sends to OpenAI, the plugin sends nothing anywhere.
- Codex's conversation records are only read, never modified.

## Development

- `plugin/` is the plugin itself: the MCP server, the engine, the panel and the `cam` command line (runtime code in `plugin/src`). `spike/` holds the tests and experiments, `scripts/` the one-line install and uninstall scripts, and `docs/` the spec and the technical design (in Chinese; start with [docs/spec.md](docs/spec.md)). The development records of v0.1 are in `docs/history/v0.1/`.
- Install from source into your Codex: quit Codex, run `cam install` in the repository (`./cam install` on macOS and Linux), then start Codex. `cam status` shows the installation, `cam uninstall` removes it.
- Run the tests with Node 24 or later: `cd spike && node --test`. CI runs them on Windows, macOS and Linux, then installs the plugin with Codex's CLI and runs the install and uninstall scripts.
- Work on the panel without Codex: `node spike/scripts/panel-dev.ts`, then open `http://127.0.0.1:17895/?solo=1`. The page uses synthetic images and a temporary Codex folder, so your real data is never read or changed.
- When you change the text the model sees (`plugin/src/rewrite.ts`), run the self-tests in `spike/src/v01-placeholder-selftest.ts` and `spike/src/v01-needs-selftest.ts`, in Chinese and with `--lang en`. They start their own engine and app-server, use your Codex account, and archive the test tasks they create.
- Release notes: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
