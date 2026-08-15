# opencode-acpx

[![npm](https://img.shields.io/npm/v/opencode-acpx)](https://www.npmjs.com/package/opencode-acpx)
[![CI](https://github.com/intellectronica/opencode-acpx/actions/workflows/ci.yml/badge.svg)](https://github.com/intellectronica/opencode-acpx/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use ACP agents as first-class [OpenCode](https://opencode.ai) providers.
`opencode-acpx` discovers each agent's models, preserves its stateful session,
and streams reasoning, tools, plans, todos and subagent activity through
OpenCode. Model-specific reasoning effort and fast-mode controls appear as
normal OpenCode variants.

The plugin is built on [Acpx](https://github.com/openclaw/acpx) and requires no
changes to OpenCode or the ACP agent.

## Supported agents

| Preset       | ACP command                                           | Notes                                      |
| ------------ | ----------------------------------------------------- | ------------------------------------------ |
| `cursor`     | `cursor-agent acp`, falling back to `agent acp`       | Install and authenticate Cursor separately |
| `claude`     | Bundled Claude Agent ACP adapter                      | Adapter version is pinned by this package  |
| `codex`      | Bundled Codex ACP adapter                             | Adapter version is pinned by this package  |
| `grok-build` | `grok agent --no-leader stdio`                        | Install and authenticate Grok separately   |
| `hermes`     | `hermes acp`, falling back to `hermes-acp`            | Install and configure Hermes separately    |
| `custom`     | Any configured ACP v1 command using NDJSON over stdio | Capability-detected                        |

## Requirements

- OpenCode `>=1.18.15 <2`
- Node.js `>=22.13`
- Any system agent you enable, already installed and authenticated

Claude Agent ACP and Codex ACP are installed with the plugin. Cursor, Grok and
Hermes are not installed or updated automatically.

## Install

Add the plugin and at least one server to `opencode.json`:

```jsonc
{
  "plugin": [
    [
      "opencode-acpx",
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

Restart OpenCode, open the model picker, and select a model under
**Cursor (ACP)**. The provider ID is `acp.cursor`; other server IDs follow the
same `acp.<server-id>` pattern.

OpenCode installs npm plugins automatically. To pin this release, use
`"opencode-acpx@0.0.1"` in the plugin entry.

## Configure

Several agents can run together:

```jsonc
{
  "plugin": [
    [
      "opencode-acpx",
      {
        "permissions": {
          "default": "ask",
          "fallback": "deny",
        },
        "servers": {
          "cursor": {
            "preset": "cursor",
            "mode": "agent",
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

Each agent's exact model IDs are discovered at startup. Standard ACP
`thought_level`, known model-scoped configuration, and supported Cursor/Grok
reasoning controls are exposed as OpenCode variants. Permission, workflow and
persona modes remain session controls rather than being mislabelled as
thinking effort.

Normal OpenCode model filters work with ACP providers:

```jsonc
{
  "provider": {
    "acp.cursor": {
      "whitelist": ["grok-4.6"],
    },
  },
}
```

The strict options schema also supports explicit model fallbacks, initial ACP
config values, MCP servers, custom commands, skill policies and per-server
process isolation. See the full [configuration guide](docs/configuration.md)
and [compatibility matrix](docs/compatibility.md).

### ACP over SSH

Override a preset's `command` and `args` to launch its ACP process differently.
ACP uses stdio, so the override can be an SSH command that carries the stream
to another machine. For example:

```jsonc
{
  "preset": "hermes",
  "command": "/usr/bin/ssh",
  "args": [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "mac-mini",
    "exec hermes acp",
  ],
  "cwd": "/Users/example",
  "authProfile": "mac-mini",
}
```

Use key-based authentication and a verified host key. The remote command must
keep stdout exclusively for ACP NDJSON and send logs to stderr. More defensive
SSH options and path requirements are documented in
[configuration](docs/configuration.md#acp-stdio-over-ssh).

## How it behaves

- One durable ACP conversation is kept for each OpenCode session, server and
  worktree.
- Assistant text and thought traces stream as OpenCode text and reasoning.
- ACP-owned tool calls are displayed without being executed a second time by
  OpenCode. Known shapes use native shell, read, search, edit, write, web, todo
  and task presentation; unknown shapes retain structured ACP metadata.
- Standard plans and known agent todo extensions populate OpenCode's native
  todo list. Cursor, Claude, Codex and Grok subagent events use native task
  activity where their protocol data permits it.
- Permissions and questions use OpenCode's normal UI and fail closed if a
  correlated response cannot be obtained.
- Agent-native rules, commands, skills, MCP servers, memory and hooks remain
  active inside the agent. ACP-advertised commands are added to OpenCode's
  startup catalogue when available.

ACP is a stateful agent protocol, so these providers are not stateless LLM
endpoints. Discovery is a startup snapshot; reload the plugin after changing
an agent's available models or commands.

## Security

ACP agents can read and modify files, run commands and access networks. The
default policy asks through OpenCode and falls back to denial. Presets never
enable force, yolo, full-access or always-approve modes. Only explicitly named
environment variables are forwarded to an agent.

Read the [security model](docs/security.md) before enabling broad permissions
or remote agents. Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/intellectronica/opencode-acpx/security/advisories/new).

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
```

The release gate runs formatting, lint, strict TypeScript, unit and real-process
ACP integration tests, the production build, and packed-export verification.
See [testing](docs/testing.md) and [architecture](docs/architecture.md) for more.

## Licence

MIT. The bundled Acpx compatibility code retains its MIT notice in
[`LICENSES/acpx-MIT.txt`](LICENSES/acpx-MIT.txt).
