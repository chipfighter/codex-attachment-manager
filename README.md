<p align="center">
  <img src="plugin/assets/logo.png" width="96" height="96" alt="">
</p>

<h1 align="center">Context Attachment Manager</h1>

<p align="center">Choose which past images go to the model with your next message, in Codex and in Claude Desktop, without leaving the conversation.</p>

<p align="center">
  <a href="https://github.com/chipfighter/context-attachment-manager/actions/workflows/ci.yml"><img src="https://github.com/chipfighter/context-attachment-manager/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/chipfighter/context-attachment-manager/releases"><img src="https://img.shields.io/github/v/release/chipfighter/context-attachment-manager?include_prereleases" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform: Windows, macOS, Linux">
  <img src="https://img.shields.io/badge/Codex%20desktop-26.924-339CFF" alt="Tested on Codex desktop 26.924">
  <img src="https://img.shields.io/badge/Claude%20Desktop-Claude%20Code%202.1.295-D97757" alt="Tested in Claude Desktop with Claude Code 2.1.295">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT"></a>
</p>

<p align="center"><b>English</b> · <a href="README_CN.md">简体中文</a></p>

> **New in 0.4: it works in Claude Desktop too.** In the Code tab of Claude Desktop, install the plugin and type `/cam` in a session: the same panel opens in Claude Desktop's built-in browser, next to the conversation. Formerly *Codex Attachment Manager*; the project was renamed because it no longer works with Codex alone.

<p align="center">
  <img src="docs/images/demo.gif" alt="The panel's filter shows only the PDF page, then every image again, and the uploads are unchecked a turn at a time. Asked about the chat button in the v1 desktop mockup, the model replies need IMG-001; the panel points to IMG-001, the user checks it, and the model answers from the image: orange." width="100%">
</p>

## Why I built this

I was iterating on image generation with GPT in Codex. After a dozen or so images, the task started failing: the connection kept dropping, and the retries every few minutes never went through. Digging into it, I found that Codex sends every image in the task's history again with every request, and each request had grown to about 44 MB. The only way out was a new task, which meant losing the conversation.

So I wanted to keep the long conversation going and decide, turn by turn, which images the model still gets. Uncheck the ones you no longer need: from the next message on they become short placeholders, and the task and the conversation stay the same. Claude Code also sends the whole history with every request, so 0.4 brings the same panel to Claude Desktop.

## Features

- **Every image in one list**: the panel lists every image in the task (in Codex) or session (in Claude Code), turn by turn: the ones you uploaded and the ones the model viewed or generated, with thumbnails, IDs and sizes. Click one to preview it. In Codex it's a *Context Assets* tab in the side panel; in Claude Desktop, `/cam` opens it in the built-in browser.
- **Filter by source**: with many images, show only some sources: your uploads, PDF pages you commented on in Codex (with the page number and the PDF's name), web page screenshots, and images the model viewed, got from a tool or generated. Filtering changes what you see, never what is sent.
- **One click to leave an image out**: unchecked images become a short placeholder from the next message on. Toggle single images or a whole turn.
- **Duplicates handled**: when an identical image is still being sent, the placeholder points to it.
- **The model knows why**: a note tells the model the images were left out by you to save context, so its earlier answers still stand and it doesn't make up details it can't see.
- **The model asks, you decide**: when it needs an image, it replies `need IMG-xxx`. The panel lists what it asked for and jumps to it in one click. A checked image goes back to its place in the conversation, marked with its ID.
- **Or let the model pick** (new in 0.3): switch on *Auto-select* at the bottom of the panel, per task or session. Images from earlier turns are then left out by default, and the model fetches the ones it needs by ID, for that turn only. Images you check are pinned and go every turn. The panel shows what the model fetched in the latest turn.
- **See the savings**: the panel estimates the size of the next request and how much you save compared with sending every image, and warns you when a request could not be rewritten.
- **English and Simplified Chinese**: the panel, the tab name and the note for the model follow Codex's language, or your system's language when Codex isn't installed.
- **Stays on your machine**: the plugin sends nothing anywhere besides the requests Codex and Claude Code already make to OpenAI and Anthropic.

## How it works

- The plugin runs a small local proxy, the engine, between Codex and OpenAI, and between Claude Code and Anthropic. Before a request goes out, the engine swaps unchecked images for placeholders and adds the note; everything else is forwarded as is, including your sign-in.
- In Codex, installing points Codex at the engine. In Claude Desktop, the plugin points each Claude Code session at the engine when the session starts, and puts it back when the session ends.
- With Auto-select on, the engine does the same for the images of earlier turns you haven't pinned, and the plugin gives the model one tool, `cam_view_image`, to fetch an image back into the current turn. The placeholders before it stay as they were, so the cached part of the request isn't broken.
- Selections and the Auto-select switch are saved per task or session. Only you can change them; the model can only fetch an image for one turn, and only with Auto-select on.
- The panel doesn't go through the model and costs no tokens. In Codex it's an MCP app in the side panel; in Claude Desktop the engine serves the same page to the built-in browser, on your machine only.

## Requirements

- **Codex**: the Codex desktop app. Tested on Windows with Codex 26.924.
- **Claude Desktop**: the Code tab, local sessions, signed in with your Claude subscription. Tested on Windows with the Claude Code 2.1.295 that Claude Desktop runs.
- macOS and Linux: CI installs the plugin with Codex's own CLI, starts it, and runs the install and uninstall scripts, but nobody has tried it in the desktop apps on these platforms yet. [Issues](https://github.com/chipfighter/context-attachment-manager/issues) welcome.
- Node: the plugin uses the Node 24 that ships with Codex, and falls back to `node` 24 or later on your PATH. Claude Desktop doesn't ship Node, so without Codex, install [Node 24 or later](https://nodejs.org).

## Install

### In Codex, no terminal

1. On Codex's **Plugins** page, click **Add a marketplace**, enter `chipfighter/context-attachment-manager` as the **Source**, leave the rest empty, and click **Add marketplace**.
2. Install **Context Attachment Manager** from the list.
3. Open a task, click **Toggle side panel** at the top right, open a new tab with **+**, and choose **Context Assets** under **Plugins and MCPs**. If it isn't there, restart Codex once.
4. The panel says the plugin is not enabled yet. Click **Enable plugin**, then restart Codex.

### In Codex, one command

Windows (PowerShell):

```powershell
irm https://github.com/chipfighter/context-attachment-manager/releases/latest/download/install.ps1 | iex
```

macOS and Linux:

```bash
curl -fsSL https://github.com/chipfighter/context-attachment-manager/releases/latest/download/install.sh | sh
```

The command installs the plugin with Codex's own CLI and sets up the proxy. Restart Codex afterwards. Run it again later to upgrade.

What installing changes in Codex:

- Adds a marked proxy block to `~/.codex/config.toml`, after backing the file up.
- If a proxy is set in your environment variables, adds a marked `NO_PROXY` block with local addresses only to `~/.codex/.env`.
- Nothing else. If you have set `openai_base_url` yourself, installing stops without writing anything.

### In Claude Desktop

Claude Desktop installs plugins only from marketplaces you have added, and adding one from GitHub takes the `claude` command, Claude Code's command line ([setup guide](https://code.claude.com/docs/en/setup)). Once:

```bash
claude plugin marketplace add chipfighter/context-attachment-manager
```

```bash
claude plugin install codex-attachment-manager@codex-attachment-manager
```

Instead of the second command, you can also install it in the Code tab: click **+** next to the prompt box, choose **Plugins**, then **Add plugin**, pick **Context Attachment Manager**, and install it for your user account. The install ID keeps the project's old name.

Then start a new session in the Code tab. There is nothing to set up: the plugin doesn't edit any settings, and only points that session's own Claude Code process at the engine while it runs.

## Usage

### In Codex

1. Open **Context Assets** in the side panel of a task. On a new chat you can open it before the first message; it switches to the task once you send.
2. Uncheck the images you don't want to send anymore. Each change is saved at once and applies from the next message.
3. When the model replies `need IMG-xxx` for an unchecked image, a bar at the top of the panel lists it. Click the ID to jump to the image and check it.
4. With many images, click the filter button next to refresh and pick the sources to show. A turn's checkbox then covers only the images shown.
5. To let the model pick, switch on **Auto-select** at the bottom of the panel. Check the images that should go every turn, such as a reference image; the model fetches the others when it needs them. Switch it off to get your own checks back.

### In Claude Desktop

1. In a session in the Code tab, type `/cam` and send it. The panel opens in Claude Desktop's built-in browser, next to the conversation. If `/cam` is your first message in a new session, the prompt box may say the command doesn't exist: send it anyway. Claude Desktop starts the session when you send your first message, and the plugin adds `/cam` then.
2. From there it works as in Codex: uncheck, check again, answer `need IMG-xxx`, filter, or switch on **Auto-select**. Changes apply from the next message.
3. With Auto-select on, the model's `cam_view_image` calls don't ask for your permission, unless your own Claude Code settings or hooks say otherwise.

If the built-in browser can't be used (in the terminal, for example), `/cam` shows a small pane with a link to the panel instead.

## Uninstall

### Codex

Disable first, then remove: click **Disable plugin** in the panel, remove the plugin on the **Plugins** page, and restart Codex.

Or run the uninstall command. It restores the direct connection and removes the plugin, and it works even when the plugin files are gone:

Windows (PowerShell):

```powershell
irm https://github.com/chipfighter/context-attachment-manager/releases/latest/download/uninstall.ps1 | iex
```

macOS and Linux:

```bash
curl -fsSL https://github.com/chipfighter/context-attachment-manager/releases/latest/download/uninstall.sh | sh
```

**If Codex can't connect** and its errors mention `localhost:17891` (for example, the plugin was removed without disabling it first), run the uninstall command above and restart Codex. On macOS and Linux the engine also restores the direct connection by itself once the plugin is removed or turned off, from the next start of Codex.

### Claude Desktop

Uninstall it with **Manage plugins** under **+** → **Plugins** in the Code tab, or with `claude plugin uninstall codex-attachment-manager@codex-attachment-manager`. New sessions then connect directly; there is nothing to restore.

Your selections and logs stay in the data folder (see [Privacy](#privacy)); delete it if you don't need them.

## Good to know

- Only images are managed, because they are the only files that reach the model as they are. Codex doesn't send PDFs or videos themselves, only text the model extracts from them or images it makes of them, and those images are listed like any other. Audio waits for a model that accepts it: until then, Codex replaces audio with a short note before sending.
- Results of Codex's built-in image generation can't be unchecked.
- With Auto-select on, each image the model fetches adds a request to that turn. Smaller models may misread small details in an image they fetched: in our tests GPT-6 Luna at low effort sometimes did, as it does with images opened with Codex's own image viewer, while GPT-6 Sol and Astra read them right. Pin an image whose details matter, or use a larger model.
- **Claude accounts created on or after August 31, 2026** check the model's earlier thinking against the conversation before it. To leave an image out on such an account, the engine also leaves out the earlier thinking that no longer matches the conversation as sent, so the model may think again and use more tokens; the panel tells you each time. Thinking from after the change is kept, and checking the image again brings back the thinking from before. Older accounts aren't affected.
- In Claude Code, the main conversation is managed; subagents keep their own history as it is. Sessions that use another API address or a cloud provider (Bedrock, Vertex, Foundry) are left alone.
- If you uncheck an image while a Codex turn is still running over WebSocket, the rest of that turn still carries the original. The panel tells you; the change applies from the next message.
- In Codex, enabling, disabling and upgrading take effect after you restart Codex. In Claude Desktop, a new plugin version takes effect in new sessions: upgrade with `claude plugin marketplace update codex-attachment-manager`, then `claude plugin update codex-attachment-manager@codex-attachment-manager`.
- After you switch Codex's language, the panel changes right away and the note for the model changes from the next message, but the tab name in the side panel changes only after a restart.
- Right after Codex starts, the engine may restart a few times and you may see "Reconnecting" once.
- The engine goes through your system proxy: on Windows it reads the system setting, on macOS it supports HTTP(S) proxies only (no PAC or SOCKS), and on Linux it reads `HTTPS_PROXY` and similar variables.

## Privacy

- All data stays in a local folder: `%USERPROFILE%\.codex-attachment-manager` on Windows, `~/Library/Application Support/codex-attachment-manager` on macOS, `~/.local/share/codex-attachment-manager` on Linux. It holds your selections, request statistics (sizes and counts only, never content), hashes the engine uses to tell which thinking still matches (never content), logs (no conversation content or credentials) and the backup of `config.toml`.
- Besides the requests Codex and Claude Code already send to OpenAI and Anthropic, the plugin sends nothing anywhere.
- The conversation records of Codex and Claude Code are only read, never modified.

## Development

- `plugin/` is the plugin itself: the MCP server, the engine, the panel and the `cam` command line (runtime code in `plugin/src`). The Claude plugin is `.claude-plugin/` plus the mod in `hooks/`. `spike/` holds the tests and experiments, `scripts/` the one-line install and uninstall scripts, and `docs/` the spec and the technical design (in Chinese; start with [docs/spec.md](docs/spec.md)). The development records of v0.1 are in `docs/history/v0.1/`.
- Install from source into your Codex: quit Codex, run `cam install` in the repository (`./cam install` on macOS and Linux), then start Codex. `cam status` shows the installation, `cam uninstall` removes it.
- Run the tests with Node 24 or later: `cd spike && node --test`. CI runs them on Windows, macOS and Linux, then installs the plugin with Codex's CLI and runs the install and uninstall scripts.
- Work on the panel without Codex: `node spike/scripts/panel-dev.ts`, then open `http://127.0.0.1:17895/?solo=1`. The page uses synthetic images and a temporary Codex folder, so your real data is never read or changed.
- When you change the text the model sees (`plugin/src/rewrite.ts`), run the self-tests in `spike/src/v01-placeholder-selftest.ts` and `spike/src/v01-needs-selftest.ts`, and for Auto-select's wording `spike/src/v03-auto-selftest.ts`, in Chinese and with `--lang en`. They start their own engine and app-server, use your Codex account, and archive the test tasks they create.
- Release notes: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
