# Changelog

All notable changes to this private package are recorded here. The format is
based on Keep a Changelog and the package uses Semantic Versioning for its
plugin contract.

## [Unreleased]

### Added

- Native OpenCode shell, read, list, search, edit, write, web, todo and task
  presentation for recognised ACP tool activity, with structured ACP metadata
  retained on fallback cards.
- Cursor, Claude, Codex and Grok subagent activity projection, plus the shared
  ACP task-shape fallback used by Hermes and custom agents.

### Fixed

- Preserve OpenCode provider whitelist/blacklist settings when injecting an ACP
  provider, including base-ID expansion for parameterised Cursor model IDs.
- Correlate session-less Cursor task notifications by tool-call ID and suppress
  redundant control-tool cards for informational task/todo extensions.

## [0.1.0] - 2026-08-15

### Added

- One-package OpenCode server, TUI, internal `LanguageModelV3` provider and
  Node worker design.
- Exact Acpx, ACP SDK, AI SDK and OpenCode compatibility pins.
- Cursor, Claude, Codex, Grok Build and Hermes presets.
- Persistent ACP session identity, per-session ordering and idempotency ledger.
- Streaming text, reasoning, remote tool, usage and interaction translation.
- Fail-closed OpenCode permission bridge.
- Dynamic session model/config/command discovery with configured fallbacks.
- Deterministic ACP stdio fixture, integration suite and packaging checks.
- Architecture, security, configuration, compatibility and testing guides.
