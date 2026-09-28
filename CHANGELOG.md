# Changelog

When a version is released, its section here becomes the GitHub release notes.

## [0.1.0] - 2026-09-28

The first public release (MVP): in the same Codex task, decide turn by turn which past images go to the model with your next message.

### Features

- A *Context Assets* tab in the side panel of the Codex desktop app lists every image in the task's history by turn: the ones you uploaded and the ones the model viewed or generated, with thumbnails, IDs, source, dimensions and size. Click one to preview it.
- Checked images are sent as usual; unchecked ones become placeholders from the next message on, and one click applies the change. When an identical image is still being sent, the placeholder points to it. The task and the conversation stay the same.
- When images are left out, the model gets a context management note: you left the originals out to save context, and the answers it gave while looking at them still stand. The model doesn't take back earlier answers or make up details it can't see, and replies "need IMG-xxx" when it needs an original. A checked image goes back to its place in the conversation, marked with its ID, so the model recognizes it and answers from the image.
- The panel estimates the size of the next request and how much you save compared with sending every image, and warns you when a request could not be rewritten or a WebSocket turn still carries the originals.
- For tasks with many images: the images the model asked for but you haven't checked are listed at the top of the panel, and clicking an ID jumps to the image. Each turn can be checked or unchecked as a whole.
- The panel, its tab name and the note for the model follow Codex's language (English or Simplified Chinese).
- Install without a terminal: add the plugin marketplace on Codex's Plugins page, install the plugin, and click "Enable plugin" in the panel. One-line install and uninstall commands are available too.
- Before uninstalling, click "Disable plugin" in the panel so Codex connects directly again. The uninstall command needs no plugin files and restores the connection even when Codex can't connect.
- After an upgrade, the new engine takes over from the old one, and requests already in flight finish normally.

### Platforms

- Windows: tested with the Codex desktop app 26.924.
- macOS and Linux: CI verifies that Codex installs the plugin and starts the plugin server and the engine, and that the install and uninstall scripts work. Nobody has tried the desktop app on these platforms yet; feedback in the issues is welcome.
