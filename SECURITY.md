# Security Policy

## Supported versions

Security fixes go into the latest release only.

## Reporting a vulnerability

Please don't report security problems in public issues. Use GitHub's private vulnerability reporting instead: on the repository's **Security** tab, click **Report a vulnerability**, or go straight to [the report form](https://github.com/chipfighter/codex-attachment-manager/security/advisories/new). Only you and the maintainer can see the report.

Please include what you found, how to reproduce it, and the plugin version and platform you used.

## What to look at

The plugin runs a local proxy (the engine) between Codex and OpenAI, and on install it edits `~/.codex/config.toml` (and `~/.codex/.env` when needed). Problems like these are especially worth reporting:

- The engine accepts connections from other machines, or forwards requests anywhere other than OpenAI.
- Credentials or conversation content end up in logs or in the data directory.
- The install or uninstall scripts change more than the README says.
