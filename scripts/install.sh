#!/bin/sh
# Purpose: v0.1-5 - install the Codex attachment manager on macOS or Linux in one line, without opening GitHub:
#   curl -fsSL https://github.com/chipfighter/context-attachment-manager/releases/latest/download/install.sh | sh
# Codex's own command line adds this repository as a plugin marketplace and installs the plugin; the installed plugin
# then points Codex at its local engine (cam setup) and starts it. Running it again upgrades. Restart Codex afterwards.
# Input: CAM_REF (a tag or branch; a release sets its own tag), CAM_SOURCE (a local checkout, for tests),
# CODEX_CLI_PATH, CODEX_HOME. Output: Codex's plugin cache, config.toml (backed up first) and, when needed, .env.
set -eu

repo=chipfighter/context-attachment-manager
name=codex-attachment-manager
plugin="$name@$name"

find_codex() {
  if [ -n "${CODEX_CLI_PATH:-}" ] && [ -x "$CODEX_CLI_PATH" ]; then printf '%s\n' "$CODEX_CLI_PATH"; return 0; fi
  # The desktop app ships one; Codex's own installer puts it in ~/.local/bin.
  for candidate in \
    /Applications/ChatGPT.app/Contents/Resources/codex \
    /Applications/Codex.app/Contents/Resources/codex \
    "$HOME/Applications/ChatGPT.app/Contents/Resources/codex" \
    "$HOME/Applications/Codex.app/Contents/Resources/codex" \
    "$HOME/.local/bin/codex"
  do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  command -v codex
}

codex=$(find_codex) || {
  printf '%s\n' 'Codex command line not found. Install Codex (the desktop app, or the command line), or set CODEX_CLI_PATH.' >&2
  exit 1
}
codex_home=${CODEX_HOME:-$HOME/.codex}
# A release replaces the placeholder with its own tag; a copy from the repository follows the default branch.
ref=${CAM_REF:-__CAM_REF__}
case "$ref" in __*) ref= ;; esac
source=${CAM_SOURCE:-$repo}

printf 'Installing the plugin with %s ...\n' "$codex"
# Added afresh, so the marketplace follows the release this script came with.
"$codex" plugin remove "$plugin" >/dev/null 2>&1 || true
"$codex" plugin marketplace remove "$name" >/dev/null 2>&1 || true
if [ -n "${CAM_SOURCE:-}" ] || [ -z "$ref" ]; then
  "$codex" plugin marketplace add "$source"
else
  "$codex" plugin marketplace add "$source" --ref "$ref"
fi
"$codex" plugin add "$plugin"

installed=$(ls -dt "$codex_home/plugins/cache/$name/$name"/*/ 2>/dev/null | head -n 1)
installed=${installed%/}
if [ -z "$installed" ]; then
  printf 'The plugin did not arrive in %s.\n' "$codex_home/plugins/cache/$name/$name" >&2
  exit 1
fi
# The installed plugin writes the proxy settings itself (checking for conflicts first) and starts its engine.
printf '%s\n' 'Pointing Codex at the local engine ...'
if ! "$installed/scripts/launch" "$installed/src/cam.ts" setup; then
  printf '%s\n' 'The proxy settings were not written (see above); Codex still connects directly.' >&2
  exit 1
fi
printf '\n%s\n' 'Done. Restart Codex, then open the panel from the side panel: New tab > Plugins and MCP.'
