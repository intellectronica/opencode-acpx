# Security model

An ACP agent can read and change files, run commands, access networks and call
MCP tools. Installing this plugin does not make those actions harmless. The
plugin treats the ACP agent as a separate privileged process and provides a
second policy boundary at OpenCode's permission UI.

## Defaults

- Permissions are interactive and fall back to denial.
- The worker uses Acpx `deny-all` policy and resolves each ACP request through
  an explicit plugin callback.
- Every answer selects an option actually offered by the ACP agent.
- An absent or unsupported UI cancels the request.
- Permanent approval is visually and semantically distinct from one-time
  approval.
- Full-access, yolo and always-approve agent flags are never added by presets.
- Agent executables are not installed, updated or authenticated automatically.
- Environment values are never placed in provider configuration or the worker
  command line.

## Process and IPC isolation

The server plugin creates a Node worker with a minimal environment. It forwards
only platform process variables and server variables explicitly listed in
`forwardEnv`; configured `env` values cross the worker boundary only when the
ACP session is created.

IPC messages require a random 256-bit token inherited only by the worker. The
token is not stored in OpenCode provider options. Frames have a fixed maximum
size and strict schemas. The worker watches its OpenCode parent, owns every ACP
child and closes its known runtime handles during disposal.

State directories are created with mode `0700`; binding-ledger temporary and
lock files use `0600`. Atomic replacement prevents partially written JSON
records. A short file lease protects bindings shared by several OpenCode
processes. Acpx owns its session-store files and applies its own storage modes.

## Permission correlation

The ACP request, reserved OpenCode tool call and OpenCode permission events are
bound by an opaque interaction identifier, server, session, message, tool call
and expiry. The agent cannot nominate that token. Unknown, expired, duplicated
or cross-session replies are rejected.

The plugin observes OpenCode's `permission.asked` and `permission.replied`
events so it can preserve `once`, `always` and `reject`. If an existing OpenCode
rule permits an action without emitting an event, the plugin grants only once
unless it can prove a matching remembered rule.

## MCP

ACP-provided MCP definitions are passed at session creation. Native agent MCP
configuration remains enabled by default. Because several agents import Cursor,
Claude or generic `.mcp.json` configuration, plugin inheritance is opt-in and
deduplicated by server name to avoid starting a service twice.

Remote MCP headers and stdio environment values are secrets. They are kept in
worker configuration and redacted from diagnostics.

## Logs and traces

Normal logging includes server identifiers, capability names, versions and
opaque session hashes. It excludes prompts, raw environment values, API keys,
tokens and full extension payloads.

The `trace` option enables Acpx's verbose, redacted diagnostics and is off by
default. Raw ACP messages remain in the worker's in-memory event channel; this
release does not write a raw protocol trace file. ACP stdout remains reserved
for protocol frames.

## Agent-specific cautions

- Cursor's process-global model state requires process isolation by worktree and
  model configuration.
- Codex `agent-full-access`, Claude bypass permission modes and Grok always
  approval require an explicit user choice and remain visible in diagnostics.
- Hermes 0.20.1 has known toolset-scoping defects; plugin permission handling or
  an external sandbox is required for a reliable boundary.
- An agent's native policy can deny an operation even after OpenCode permits it.
  The more restrictive decision wins.

## Reporting

Use
[GitHub private vulnerability reporting](https://github.com/intellectronica/opencode-acpx/security/advisories/new)
and include the plugin version, OpenCode version, preset, agent version and a
redacted reproduction. Do not attach unredacted traces or credentials to an
issue.
