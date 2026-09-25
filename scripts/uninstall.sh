#!/bin/sh
# Purpose: v0.1-5 - remove the Codex attachment manager on macOS or Linux in one line; also the way back when Codex
# cannot connect because the plugin was removed without turning it off in the panel first:
#   curl -fsSL https://github.com/chipfighter/codex-attachment-manager/releases/latest/download/uninstall.sh | sh
# Takes out only the marked blocks this tool wrote to config.toml and .env (config.toml is backed up first), then removes
# the plugin and its marketplace with Codex's own command line. Needs neither Node nor any of the plugin's files.
# Input: CODEX_HOME, CAM_DATA_DIR, XDG_DATA_HOME, CODEX_CLI_PATH. Output: config.toml, .env, Codex's plugin cache.
set -eu

name=codex-attachment-manager
plugin="$name@$name"
codex_home=${CODEX_HOME:-$HOME/.codex}
if [ -n "${CAM_DATA_DIR:-}" ]; then data_dir=$CAM_DATA_DIR
elif [ "$(uname -s)" = Darwin ]; then data_dir="$HOME/Library/Application Support/$name"
else data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/$name"
fi

# The rule the plugin itself uses (codexconfig.ts): drop every marked block; a block at the very top takes the blank
# line after it along. A BOM and CRLF line endings stay as they were. Writes the result to $2; exit status 1 when
# there was nothing to remove, 2 when a block has no end marker.
strip_blocks() {
  awk '
    function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
    { line[NR] = $0 }
    END {
      bom = "\357\273\277"
      proxy = "# >>> codex-attachment-manager: managed proxy setting, remove it with the tool >>>"
      mcp = "# >>> codex-attachment-manager: managed MCP server, remove it with the tool >>>"
      stop = "# <<< codex-attachment-manager <<<"
      if (NR > 0 && substr(line[1], 1, 3) == bom) { hadbom = 1; line[1] = substr(line[1], 4) }
      kept = 0; changed = 0
      for (i = 1; i <= NR; i++) {
        t = trim(line[i])
        if (t != proxy && t != mcp) { out[++kept] = line[i]; continue }
        j = i + 1
        while (j <= NR && trim(line[j]) != stop) j++
        if (j > NR) exit 2
        top = (kept == 0)
        i = j
        if (top && i < NR && (line[i + 1] == "" || line[i + 1] == "\r")) i++
        changed = 1
      }
      if (!changed) exit 1
      for (k = 1; k <= kept; k++) printf "%s%s\n", (k == 1 && hadbom ? bom : ""), out[k]
    }' "$1" > "$2"
}

# Only replaces the file when something was removed; the new text goes in place in one step.
clean() {
  file=$1
  [ -f "$file" ] || return 1
  status=0
  strip_blocks "$file" "$file.cam-tmp" || status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$file.cam-tmp"
    if [ "$status" -eq 2 ]; then printf 'A marked block in %s has no end marker; the file was left as it is.\n' "$file" >&2; exit 1; fi
    return 1
  fi
  return 0
}

config="$codex_home/config.toml"
if clean "$config"; then
  mkdir -p "$data_dir/config-backup"
  cp "$config" "$data_dir/config-backup/config.toml.$(date -u +%Y-%m-%dT%H-%M-%S.000Z)"
  mv "$config.cam-tmp" "$config"
  printf '%s\n' 'Codex connects directly again: the proxy settings were taken out of config.toml.'
else
  printf '%s\n' 'config.toml holds no proxy settings of this tool.'
fi
dotenv="$codex_home/.env"
if clean "$dotenv"; then
  # A .env that held nothing but this block is deleted rather than left empty.
  if awk 'NR == 1 { sub(/^\357\273\277/, "") } /[^ \t\r]/ { found = 1 } END { exit found ? 1 : 0 }' "$dotenv.cam-tmp"; then
    rm -f "$dotenv" "$dotenv.cam-tmp"
  else
    mv "$dotenv.cam-tmp" "$dotenv"
  fi
  printf '%s\n' 'The NO_PROXY block was taken out of .env.'
fi

codex=
if [ -n "${CODEX_CLI_PATH:-}" ] && [ -x "$CODEX_CLI_PATH" ]; then codex=$CODEX_CLI_PATH; fi
for candidate in \
  /Applications/ChatGPT.app/Contents/Resources/codex \
  /Applications/Codex.app/Contents/Resources/codex \
  "$HOME/Applications/ChatGPT.app/Contents/Resources/codex" \
  "$HOME/Applications/Codex.app/Contents/Resources/codex" \
  "$HOME/.local/bin/codex"
do
  if [ -z "$codex" ] && [ -x "$candidate" ]; then codex=$candidate; fi
done
if [ -z "$codex" ]; then codex=$(command -v codex || true); fi
if [ -n "$codex" ]; then
  "$codex" plugin remove "$plugin" >/dev/null 2>&1 || true
  "$codex" plugin marketplace remove "$name" >/dev/null 2>&1 || true
  printf '%s\n' 'The plugin and its marketplace were removed from Codex.'
else
  printf '%s\n' 'Codex command line not found: remove the plugin on the Plugins page in Codex.'
fi
printf '\nDone. Restart Codex. Selections and logs stay in %s; delete that folder if you do not need them.\n' "$data_dir"
