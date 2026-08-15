# opencode-acpx

Private, plugin-only ACP integration for OpenCode. Each configured ACP agent is
published as an `acp.<server-id>` provider with its dynamically discovered
models, persistent sessions, native tools, reasoning, permissions, commands,
skills, MCP configuration and supported interaction flows.

The implementation changes neither OpenCode nor Acpx upstream. It ships a
pinned `acpx@0.13.0` runtime patch inside this package to expose the protocol
callbacks required for full-fidelity ACP operation.

## What it provides

- One OpenCode plugin package with server, AI SDK `LanguageModelV3`, worker and
  optional TUI entry points.
- Presets for Cursor Agent, Claude Agent ACP, Codex ACP, Grok Build and Hermes,
  plus arbitrary local ACP v1 stdio agents.
- Account-scoped model and configuration discovery with a safe `default`
  fallback.
- One durable ACP conversation per OpenCode session, server and worktree.
- Streaming assistant text, thought/reasoning, usage, plans and provider-owned
  tool calls without re-executing those tools in OpenCode. Standard ACP tool
  kinds are projected onto OpenCode's native shell, read, list, grep, glob,
  edit, write, web and task cards when the agent supplies enough metadata.
- OpenCode-native permission prompts with exact ACP `allow_once`,
  `allow_always`, `reject_once` and cancellation correlation.
- Standard form elicitation and Cursor questions through OpenCode's built-in
  question UI; Cursor plan approval through OpenCode permissions.
- Raw ACP messages, complete session updates, extension notifications and
  authentication metadata retained on the private worker event channel.
- Native agent skills, rules, hooks, MCP servers, memory and subagents remain
  active in the ACP agent. Advertised commands and invocable skills are added
  to OpenCode's startup command catalogue when available. Cursor task events,
  Claude/Codex subagent calls and Grok subagent lifecycle notifications are
  rendered as native OpenCode task activity; other agents receive the shared
  ACP task-shape fallback.
- Bounded, authenticated NDJSON IPC between the OpenCode plugin and a
  plugin-owned Node worker, including parent-death and idle cleanup.

ACP exposes an agent runtime rather than a stateless chat model. The provider
entries are therefore a projection of stateful agent sessions, not ordinary
LLM endpoints.

## Requirements

- OpenCode `>=1.18.15 <2`
- Node.js `>=22.13`
- pnpm `11.19.0` for development
- The selected system agent installed and authenticated:
  - Cursor: `cursor-agent` (with `agent` fallback after executable probing)
  - Grok Build: `grok`
  - Hermes: `hermes` (with `hermes-acp` fallback)

Claude Agent ACP `0.68.0` and Codex ACP `1.3.0` are exact package dependencies
and launch from the locally installed package. No runtime `npx` download is
used unless the user explicitly overrides the command.

## Installation

This repository and package are private. Clone it, install the exact lockfile,
and build it:

```sh
gh repo clone intellectronica/opencode-acpx
cd opencode-acpx
pnpm install --frozen-lockfile
pnpm build
```

Reference the local package from OpenCode's configuration. OpenCode recognises
the package's `./server` and `./tui` exports and the server injects its bundled
provider through a `file://` entry point.

## Configuration

Minimal Cursor configuration:

```jsonc
{
  "plugin": [
    [
      "/absolute/path/to/opencode-acpx",
      {
        "servers": {
          "cursor": {
            "preset": "cursor",
          },
        },
      },
    ],
  ],
}
```

Several agents can be enabled together:

```jsonc
{
  "plugin": [
    [
      "/absolute/path/to/opencode-acpx",
      {
        "stateDir": "~/.local/share/opencode/acpx",
        "permissions": {
          "default": "ask",
          "fallback": "deny",
        },
        "servers": {
          "cursor": {
            "preset": "cursor",
            "mode": "agent",
            "skills": "shared-standard",
          },
          "claude": {
            "preset": "claude",
            "forwardEnv": ["ANTHROPIC_API_KEY"],
          },
          "codex": {
            "preset": "codex",
            "forwardEnv": ["CODEX_API_KEY"],
          },
          "grok": {
            "preset": "grok-build",
            "forwardEnv": ["XAI_API_KEY"],
          },
          "hermes": {
            "preset": "hermes",
          },
        },
      },
    ],
  ],
}
```

This produces providers such as `acp.cursor`, `acp.claude` and `acp.codex`.
Select a discovered model in the normal OpenCode model picker or use the
synthetic `default` entry. Model IDs are treated as opaque strings.

The options schema is strict. See [configuration](docs/configuration.md) for
all fields, custom agents, explicit model fallbacks, MCP servers, skill
policies and preset-specific examples.

## Permissions and interactions

The default policy is interactive. The ACP process blocks while the provider
emits an ordinary OpenCode control-tool call. OpenCode renders its normal
permission or question UI, the plugin returns the exact correlated response,
and the same ACP turn continues in the next provider segment.

Interaction tokens are random, single-use, session-bound and expiring. Missing
UI, malformed payloads, expired tokens, process exit and cancellation all fail
closed. The plugin never enables Cursor force mode, Grok `--always-approve`,
Codex full access or an equivalent agent bypass by default.

URL elicitation and unknown vendor interactions use the reserved interaction
tool. Unsupported shapes return an explicit ACP cancellation or structured
method error rather than leaving the agent blocked.

## Models, commands and skills

ACP v1 has no global `models/list` or `skills/list` methods. Model discovery is
session-scoped through config options or legacy model state. Command and
invocable-skill discovery arrives through `available_commands_update` and may
change during a session.

The plugin performs a bounded startup probe, disconnects the probe process and
registers the resulting snapshot. If the agent does not support session
deletion, its remote probe session may remain in the agent's own history.
Dynamic changes remain available inside the agent; refreshing OpenCode's
server-side catalogue currently requires an OpenCode plugin reload.
Agent-native skill bodies are not copied or claimed as OpenCode-native skills.

## Architecture

```text
OpenCode server plugin
  ├─ config/provider/command injection
  ├─ permissions and question correlation
  └─ in-process provider registry
          │
          ▼
AI SDK 6 LanguageModelV3 provider
  ├─ stable OpenCode ↔ ACP session identity
  ├─ segmented control-tool continuation
  └─ ACP event → AI SDK stream translation
          │ authenticated bounded NDJSON
          ▼
plugin-owned Node worker
  ├─ Acpx runtime and persistent store
  ├─ exact process/session serialisation
  ├─ cancellation, idle cleanup and parent watch
  └─ patched full-fidelity ACP callbacks
          │ ACP v1 NDJSON over stdio
          ▼
Cursor / Claude / Codex / Grok / Hermes / custom agent
```

See [architecture](docs/architecture.md), [security](docs/security.md) and the
[compatibility matrix](docs/compatibility.md) for the detailed contracts and
known agent-specific constraints.

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm check
```

The release gate covers formatting, lint, strict TypeScript, unit tests,
real-process ACP integration tests, the patched Acpx callback surface, build
and packed-export verification. Useful focused commands are:

```sh
pnpm test:unit
pnpm test:integration
pnpm test:coverage
pnpm pack:check
```

The deterministic fake ACP agent exercises discovery, streaming, reasoning,
provider tools, permissions, elicitation, extensions, cancellation, reuse and
concurrent isolation. Real-agent checks are capability probes and remain
non-destructive unless explicitly run against a disposable workspace.

See [testing](docs/testing.md) for the complete matrix and release procedure.

## Support boundaries

- Stable ACP v1 is the production target. ACP v2 is not enabled.
- The transport is local stdio. Remote ACP HTTP/WebSocket transports are not
  exposed by this release.
- Agent features that are neither in ACP nor a known vendor extension remain
  internal to that agent.
- OpenCode-native tools are not injected into the ACP agent as MCP tools.
- Rewind/fork creates a fresh binding when the selected agent cannot fork.
- Native timeline projection is best-effort: incomplete or unknown agent tool
  shapes degrade to generic provider-executed cards with structured ACP
  metadata, while the private worker channel retains the complete event.
- Hermes is supported through its legacy ACP model surface; its own advertised
  and upstream limitations still apply.

These are protocol and host-API boundaries, rather than silent omissions. The
plugin preserves raw events and reports capability diagnostics so a newer
agent build fails visibly instead of failing creatively.

## Licence

This repository is private and `UNLICENSED`. The exact `acpx@0.13.0` patch is
distributed under Acpx's MIT licence; its text is in
[`LICENSES/acpx-MIT.txt`](LICENSES/acpx-MIT.txt).
