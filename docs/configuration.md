# Configuration

The server plugin accepts one strict options object. Unknown fields are rejected
so a misspelt security or process option cannot be silently ignored.

```jsonc
{
  "plugin": [
    [
      "opencode-acpx",
      {
        "stateDir": "~/.local/share/opencode/acpx",
        "discoveryTimeoutMs": 10000,
        "idleTimeoutMs": 900000,
        "interactionTimeoutMs": 120000,
        "trace": false,
        "permissions": {
          "default": "ask",
          "fallback": "deny",
        },
        "servers": {
          "cursor": {
            "preset": "cursor",
          },
          "claude": {
            "preset": "claude",
            "forwardEnv": ["ANTHROPIC_API_KEY"],
          },
        },
      },
    ],
  ],
}
```

Each enabled server becomes an OpenCode provider named `acp.<server-id>`.
Server identifiers may contain lower-case letters, numbers, dots, underscores
and hyphens; they must begin and end with a letter or number.

## Top-level options

| Option                 | Default                        | Meaning                                             |
| ---------------------- | ------------------------------ | --------------------------------------------------- |
| `stateDir`             | `~/.local/share/opencode/acpx` | Private sessions, catalogue and binding state       |
| `discoveryTimeoutMs`   | `10000`                        | Maximum startup catalogue probe time                |
| `idleTimeoutMs`        | `900000`                       | Close an unused process while retaining its session |
| `interactionTimeoutMs` | `120000`                       | Cancel an unanswered permission/question            |
| `trace`                | `false`                        | Enable Acpx verbose, redacted diagnostics           |
| `permissions.default`  | `ask`                          | `ask`, `allow` or `deny` host policy                |
| `permissions.fallback` | `deny`                         | `deny` or `fail` if interaction UI is unavailable   |

At least one server is required.

## Server options

| Option               | Default           | Meaning                                                         |
| -------------------- | ----------------- | --------------------------------------------------------------- |
| `preset`             | required          | `cursor`, `claude`, `codex`, `grok-build`, `hermes` or `custom` |
| `enabled`            | `true`            | Include the provider                                            |
| `command` / `args`   | preset            | Override the ACP executable and argv                            |
| `cwd`                | OpenCode worktree | Explicit process working directory                              |
| `authProfile`        | `default`         | Non-secret identity used for isolation/session fingerprints     |
| `env`                | `{}`              | Literal worker-side environment values                          |
| `forwardEnv`         | `[]`              | Named host variables allowed to enter the worker/session        |
| `models`             | `{}`              | Explicit fallback/override OpenCode catalogue                   |
| `defaultModel`       | `default`         | Synthetic or configured default model ID                        |
| `mode`               | unset             | Initial ACP mode ID                                             |
| `config`             | `{}`              | Initial ACP config-option values                                |
| `mcpServers`         | `[]`              | Additional session MCP servers                                  |
| `nativeSystemPrompt` | unset             | Replace the agent-native prompt where supported                 |
| `appendSystemPrompt` | unset             | Append instructions where supported                             |
| `allowedTools`       | preset/agent      | Acpx session option; never a substitute for permission policy   |
| `maxTurns`           | preset/agent      | Agent turn limit where supported                                |
| `processIsolation`   | preset            | `session` or `profile`                                          |
| `skills`             | `native`          | `native`, `shared-standard` or `mirror-known-roots`             |

Do not use `nativeSystemPrompt` and `appendSystemPrompt` interchangeably. Some
agents can only apply system prompt metadata when creating a fresh session;
changing either option changes the session fingerprint.

### Explicit models

```jsonc
{
  "models": {
    "default": {
      "name": "Cursor Auto",
    },
    "known-model-id": {
      "name": "Known model",
      "reasoning": true,
      "attachments": true,
      "context": 0,
      "output": 0,
      "options": {
        "thought_level": "high",
      },
    },
  },
}
```

Model IDs are opaque. Do not split Cursor bracketed variants, Hermes provider
identifiers or vendor-qualified IDs. A zero limit means unknown and disables
OpenCode context-overflow handling; the ACP agent remains responsible for its
own context.

### MCP servers

Stdio:

```jsonc
{
  "name": "local-tools",
  "command": "local-mcp-server",
  "args": ["--stdio"],
  "env": [{ "name": "SERVICE_TOKEN", "value": "..." }],
}
```

HTTP or SSE:

```jsonc
{
  "name": "remote-tools",
  "type": "http",
  "url": "https://tools.example.test/mcp",
  "headers": [{ "name": "Authorization", "value": "Bearer ..." }],
}
```

The plugin passes HTTP/SSE only when the agent advertises the corresponding ACP
MCP capability. Stdio is the ACP baseline. Values are redacted from logs.

## Preset examples

### Cursor

```jsonc
{
  "preset": "cursor",
  "mode": "agent",
  "config": {
    "thought_level": "high",
  },
  "skills": "shared-standard",
}
```

The preset resolves `cursor-agent acp` first, then `agent acp`. This ordering
avoids collisions with unrelated tools named `agent`. Authenticate separately
with Cursor's CLI login command or forward `CURSOR_API_KEY`. Do not use
`--force` as a normal permission policy.

### Claude

```jsonc
{
  "preset": "claude",
  "authProfile": "personal",
  "forwardEnv": ["ANTHROPIC_API_KEY"],
  "config": {
    "mode": "default",
    "effort": "high",
  },
}
```

### Codex

```jsonc
{
  "preset": "codex",
  "forwardEnv": ["CODEX_API_KEY"],
  "mode": "agent",
  "config": {
    "reasoning_effort": "high",
  },
}
```

`agent-full-access` is deliberately absent from this example and should only be
selected explicitly after reviewing its network and filesystem implications.

### Grok Build

```jsonc
{
  "preset": "grok-build",
  "forwardEnv": ["XAI_API_KEY"],
  "processIsolation": "session",
}
```

The preset runs `grok agent --no-leader stdio`. It never adds
`--always-approve`.

### Hermes

```jsonc
{
  "preset": "hermes",
  "env": {
    "HERMES_HOME": "/absolute/path/to/hermes-profile",
  },
  "mode": "default",
}
```

Hermes owns its provider credentials. Run `hermes acp --setup` separately when
needed. Set `HERMES_ACP_SKIP_CONFIGURED_MCP=1` only if the plugin is deliberately
supplying the complete MCP inventory.

### Custom server

```jsonc
{
  "preset": "custom",
  "command": "/absolute/path/to/my-acp-agent",
  "args": ["--stdio"],
  "models": {
    "default": { "name": "My agent" },
  },
}
```

The custom executable must implement ACP v1 over stdio and keep stdout free of
logs. Optional behaviour is capability-gated exactly like a preset.
