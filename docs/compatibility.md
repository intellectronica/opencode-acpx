# Compatibility

The plugin targets OpenCode `>=1.18.15 <2`, AI SDK 6's `LanguageModelV3`, ACP
wire protocol v1 and `acpx@0.13.0`. ACP v2 remains draft and is not enabled by
default.

## Shared feature mapping

| ACP feature                               | OpenCode representation                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Model config option or legacy model state | Provider model catalogue                                             |
| Model parameters and thought level        | Model options/variants and session config                            |
| Agent mode                                | Session control and configured default                               |
| Agent text                                | Assistant text                                                       |
| Agent thought                             | Reasoning                                                            |
| Agent-native tool                         | Provider-executed dynamic tool                                       |
| Plan                                      | ACP update retained on the private worker event channel              |
| Permission request                        | Reserved plugin tool and OpenCode permission UI                      |
| Form or URL elicitation                   | Question/control tool when representable; otherwise cancel           |
| Available command                         | Startup OpenCode command snapshot                                    |
| Agent-native skill                        | Remains available inside the agent                                   |
| Session lifecycle                         | Persistent Acpx binding with capability-gated load/resume/close/fork |
| MCP server                                | ACP session MCP definition, capability-gated by transport            |

ACP v1 has no global model or skill catalogue. Discovery is session-scoped and
dynamic. Catalogue entries are therefore per-instance snapshots;
re-authentication or an agent update may require an OpenCode reload.

## Presets

### Cursor Agent

- Preferred command: `cursor-agent acp`; fallback: `agent acp` after checking
  that the executable exists. This avoids collisions with unrelated binaries
  also named `agent`.
- Models and parameters are account-scoped and treated as opaque values.
- Modes: `agent`, `plan`, `ask` when advertised.
- Images are currently advertised; audio and embedded context are not.
- Load/list are capability-tested; resume/fork/close/delete are not assumed.
- Current Cursor builds require one process per worktree/session/model profile.
- Native rules, skills, commands, plugins, hooks, MCP, code index and subagents
  remain active. Advertised commands are surfaced where OpenCode permits.
- Cursor ask/plan/todo/task/image extension methods are version-gated.

### Claude Agent ACP

- Exact adapter fallback: `@agentclientprotocol/claude-agent-acp@0.68.0`.
- Dynamic model, effort, fast, agent and permission-mode config options.
- Image and embedded-context prompts; HTTP/SSE/stdio MCP.
- Rich session lifecycle and steering are capability-gated.
- AskUserQuestion requires form elicitation; device/remote login may require URL
  elicitation or a terminal-auth action.
- Native Claude commands and skills arrive through available-command updates.

### Codex ACP

- Exact adapter fallback: `@agentclientprotocol/codex-acp@1.3.0`.
- Dynamic model, reasoning effort, fast and collaboration controls.
- Modes include `read-only`, `agent` and explicitly dangerous
  `agent-full-access`.
- Image and embedded-context prompts; stdio/HTTP MCP; SSE is not assumed.
- Codex slash commands and `$skill` entries are surfaced from runtime updates.
- Standard form/URL elicitation covers request-user-input and device auth where
  advertised.

### Grok Build

- Command: `grok agent --no-leader stdio`.
- `--no-leader` prevents a shared leader from breaking plugin process isolation.
- Models and reasoning effort come from live wire metadata; model selection is
  applied before the first prompt.
- Native skills, workflows, plugins, hooks, memory, MCP and subagents remain in
  Grok. `x.ai/*` extensions are handled only when their schemas are recognised.
- The current CLI remains alpha; every exact build receives a capability
  fingerprint and newer builds warn until tested.

### Hermes

- Preferred command: `hermes acp`; fallback: `hermes-acp`.
- Supported as legacy ACP compatibility against Hermes 0.20.1 or newer
  feature-compatible releases.
- Uses legacy session models and `session/set_model`; IDs are opaque and may
  contain several colons.
- Modes: `default`, `accept_edits`, `dont_ask` when advertised.
- Native tools, memory and skills remain active, but installed skills are not
  individually advertised as ACP commands in Hermes 0.20.1.
- The current agent accepts session MCP servers without advertising MCP
  capabilities; this is reported as a compatibility warning.

## Honest limits

- Agent features not exposed through ACP or a known extension cannot be shown
  as native OpenCode UI.
- Web/desktop interaction fidelity is limited to OpenCode's existing permission
  and question/tool surfaces; the optional TUI module can add richer controls.
- OpenCode tool schemas are not automatically injected into the ACP agent.
  Agent-native tools and configured MCP remain the default.
- A model or command catalogue can change after provider initialisation; current
  OpenCode v1 requires reload for a completely new picker entry.
- Rewind/fork creates a fresh ACP generation when the agent has no tested fork
  capability.
- Remote tool output is a UI projection, not a lossless audit trail.
