# Changelog

When a version is released, its section here becomes the GitHub release notes.

## [0.3.0] - 2026-10-06

Let the model pick the images it needs.

### Features

- An *Auto-select* switch at the bottom of the panel, for each task. With it on, images from earlier turns are left out by default, even one generated a turn ago, and the model fetches the ones it needs by ID with the plugin's `cam_view_image` tool, for that turn only. The placeholders before a fetched image stay as they were, so the cached part of the request isn't broken.
- Check an image to pin it: pinned images go every turn. Pins are kept apart from your own checks, which come back as they were when you switch Auto-select off.
- The panel lists what the model fetched in the latest turn and marks those rows; click an ID to jump to one. The request estimate becomes a minimum, since what the model will fetch isn't known beforehand.
- With Auto-select off, everything works as in 0.2.0, and the requests sent are byte-identical. Codex doesn't list plugin tools to the model, so the model only learns about the tool from the note it gets with Auto-select on.

### Notes

- Tested with three GPT-6 models at low effort, in Chinese and English. GPT-6 Sol and Astra fetched the images they needed, left the rest alone, and read what they fetched correctly. GPT-6 Luna mostly decided right but sometimes misread small details in a fetched image, as it does with images opened with Codex's own image viewer. Pin an image whose details matter, or use a larger model.
- Each image the model fetches adds a request to that turn.
- Platforms are the same as in 0.2.0. On Windows, the self-tests ran on the Codex runtime of the desktop app 26.930, and the plugin runs in that app; automatic selection hasn't been tried by hand in the desktop app yet, so feedback in the issues is welcome. CI checks that the plugin installs and starts on macOS and Linux.

## [0.2.0] - 2026-09-29

Filter the panel's list by where each image came from.

### Features

- A filter button next to refresh unfolds the task's sources, each with its count: uploads, PDF pages, web page screenshots, and images the model viewed, got from a tool or generated. Pick one or several to show only their images; *All* shows everything again. The button shows only when a task has images from two sources or more, and it keeps a dot while a filter is on and the bar is folded away.
- The screenshots Codex attaches when you comment on a PDF page or a web page are told apart from your uploads. A PDF page shows its page number and the PDF's name.
- Filtering changes what you see, never what is sent: the request estimate still counts every image, a turn's checkbox covers only the images shown, and jumping to an image the model asked for shows it even when the filter hides it.
- The text sent to the model is the same as in 0.1.0.

### Notes

- Only images are managed, because Codex sends the model text and images only. PDFs and videos reach the model as text or images the model makes of them, and those images are listed like any other. The models in Codex don't accept audio yet, so Codex replaces audio with a short note before sending; audio support waits for a model that accepts it.
- Platforms are the same as in 0.1.0: tested on Windows with the Codex desktop app 26.924; CI checks that the plugin installs and starts on macOS and Linux.

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
