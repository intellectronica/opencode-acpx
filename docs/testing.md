# Testing

The test strategy checks pure contracts, the real Acpx runtime, the packed
plugin and representative agent executables. A translator-only mock is not
sufficient because most failures occur at process, protocol or OpenCode loop
boundaries.

## Local commands

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm pack:check
```

`pnpm check` runs the release gate in that order. Only Esbuild's install script
is allowed; native extraction and OpenCode post-install scripts are denied in
`pnpm-workspace.yaml`.

## Deterministic suite

Unit tests cover:

- strict configuration parsing and defaults;
- preset launch contracts;
- canonical worktree/session fingerprints;
- FIFO ordering and cancellation boundaries;
- authenticated worker envelopes and method schemas;
- binding/idempotency ledger transitions;
- prompt extraction and attachment validation;
- balanced AI SDK text/reasoning events;
- provider-executed ACP tool lifecycles;
- native shell/read/search/edit/web projection with generic fallbacks;
- Cursor, Claude, Codex and Grok subagent task projection and de-duplication;
- finish reason and usage mapping;
- interaction segmentation and cursor replay;
- exact permission/question correlation;
- malformed, oversized, expired and cross-session input.

The fixture at `test/fixtures/fake-acp-agent.mjs` is a real ACP v1 stdio child.
It supports initialisation, session creation, model and mode config options,
commands, text, thought, tools, usage, permission requests, cancellation and
session lifecycle calls. Integration tests launch it through the pinned public
`acpx/runtime`; they do not substitute a fake runtime.

## Packed-plugin verification

`pnpm pack:check` packs the actual tarball, imports the root and `./server`
exports, and verifies:

- the root has exactly one export beginning with `create`;
- the factory and `languageModel()` are synchronous;
- `./server` default-exports `{ id, server }`;
- the provider's sibling `file://` URL resolves from the installed package;
- the worker entrypoint is present and executable by Node;
- no source, state, trace, credential or development file enters the tarball.

Before release, the packed package is also installed into fresh temporary
projects and loaded by OpenCode 1.18.15 and 1.18.18 against the deterministic
ACP fixture. The manual smoke procedure inspects saved OpenCode message parts,
including a provider-executed tool, and restarts OpenCode, the plugin worker and
the ACP child before a continuation turn to prove Acpx history restoration.

## Real-agent conformance

Real-agent tests are opt-in because they need installed software and existing
accounts. They never install, update, log in or auto-approve. Each run records
the exact executable realpath, version, capability response and authentication
profile fingerprint.

The full conformance target for every supported preset is:

- unauthenticated and authenticated initialisation;
- bounded model/mode/config/command discovery;
- two persistent turns and process restart recovery;
- text, thought, native tool and usage streaming;
- allow once, allow always and reject;
- cancellation before and after observable tool activity;
- model selection read-back;
- image/file input according to advertised capabilities;
- native and session-provided MCP configuration;
- native skill or command invocation;
- two concurrent OpenCode sessions proving no cross-talk.

Cursor additionally checks ask/plan/todo/subagent extensions and distinct model
processes. Claude and Codex check form/URL elicitation and dynamic configuration.
Grok checks `x.ai/*` interactions with `--no-leader`. Hermes checks legacy model
selection, fork/load and the unadvertised MCP capability mismatch.

Any untested newer agent build produces a warning. A missing mandatory feature
fails that preset's conformance report without silently downgrading permissions.
Release notes must distinguish completed real-agent checks from this target
matrix.
