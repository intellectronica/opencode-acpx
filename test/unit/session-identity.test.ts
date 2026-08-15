import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SESSION_SCHEMA_VERSION } from "../../src/constants.js";
import {
  canonicalWorktree,
  createSessionKey,
  serverFingerprint,
} from "../../src/session/identity.js";
import { makeServerConfig } from "../helpers/config.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opencode-acpx-identity-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => {
      const { rm } = await import("node:fs/promises");
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("serverFingerprint", () => {
  it("is stable across insertion order for keyed and set-like fields", () => {
    const left = makeServerConfig({
      env: { SECOND: "two", FIRST: "one" },
      forwardEnv: ["SECOND", "FIRST"],
    });
    const right = makeServerConfig({
      env: { FIRST: "one", SECOND: "two" },
      forwardEnv: ["FIRST", "SECOND"],
    });

    expect(serverFingerprint("cursor", left)).toBe(
      serverFingerprint("cursor", right),
    );
  });

  it("does not put environment secret values into session identity", () => {
    const first = makeServerConfig({ env: { API_TOKEN: "first-secret" } });
    const second = makeServerConfig({ env: { API_TOKEN: "rotated-secret" } });

    expect(serverFingerprint("cursor", first)).toBe(
      serverFingerprint("cursor", second),
    );
  });

  it.each([
    ["server identifier", "cursor", "cursor-work", {}, {}],
    ["command", "cursor", "cursor", {}, { command: "agent" }],
    ["arguments", "cursor", "cursor", {}, { args: ["acp", "--debug"] }],
    ["auth profile", "cursor", "cursor", {}, { authProfile: "work" }],
    [
      "environment key",
      "cursor",
      "cursor",
      {},
      { env: { API_TOKEN: "secret" } },
    ],
    [
      "MCP configuration",
      "cursor",
      "cursor",
      {},
      { mcpServers: [{ name: "mcp", command: "mcp" }] },
    ],
    ["system prompt", "cursor", "cursor", {}, { nativeSystemPrompt: "Custom" }],
    ["allowed tools", "cursor", "cursor", {}, { allowedTools: [] }],
    ["turn limit", "cursor", "cursor", {}, { maxTurns: 2 }],
  ] as const)(
    "changes when %s changes",
    (_label, leftId, rightId, leftOverrides, rightOverrides) => {
      const left = serverFingerprint(leftId, makeServerConfig(leftOverrides));
      const right = serverFingerprint(
        rightId,
        makeServerConfig(rightOverrides),
      );

      expect(left).not.toBe(right);
    },
  );
});

describe("worktree canonicalisation", () => {
  it("resolves symbolic links to the same canonical path", async () => {
    const directory = await temporaryDirectory();
    const link = `${directory}-link`;
    temporaryDirectories.push(link);
    await symlink(directory, link, "dir");

    await expect(canonicalWorktree(link)).resolves.toBe(
      await realpath(directory),
    );
  });

  it("rejects a missing worktree", async () => {
    await expect(
      canonicalWorktree(join(tmpdir(), "missing-opencode-acpx-worktree")),
    ).rejects.toThrow();
  });
});

describe("createSessionKey", () => {
  it("is stable for equivalent input and uses the versioned namespace", async () => {
    const worktree = await temporaryDirectory();
    const input = {
      serverId: "cursor",
      server: makeServerConfig(),
      worktree,
      openCodeSessionId: "session-1",
    };

    const first = await createSessionKey(input);
    const second = await createSessionKey({ ...input });

    expect(second).toBe(first);
    expect(first).toMatch(
      new RegExp(
        `^opencode-acpx-v${String(SESSION_SCHEMA_VERSION)}-[a-f0-9]{64}$`,
      ),
    );
  });

  it("uses the canonical worktree rather than its spelling", async () => {
    const worktree = await temporaryDirectory();
    const link = `${worktree}-link`;
    temporaryDirectories.push(link);
    await symlink(worktree, link, "dir");
    const base = {
      serverId: "cursor",
      server: makeServerConfig(),
      openCodeSessionId: "session-1",
    };

    await expect(createSessionKey({ ...base, worktree: link })).resolves.toBe(
      await createSessionKey({ ...base, worktree }),
    );
  });

  it.each([
    ["OpenCode session", { openCodeSessionId: "session-2" }],
    ["generation", { generation: 1 }],
    ["server", { serverId: "cursor-work" }],
    [
      "server configuration",
      { server: makeServerConfig({ authProfile: "work" }) },
    ],
  ])("separates identity by %s", async (_label, override) => {
    const worktree = await temporaryDirectory();
    const base = {
      serverId: "cursor",
      server: makeServerConfig(),
      worktree,
      openCodeSessionId: "session-1",
    };

    expect(await createSessionKey({ ...base, ...override })).not.toBe(
      await createSessionKey(base),
    );
  });

  it("treats an omitted generation as generation zero", async () => {
    const worktree = await temporaryDirectory();
    const base = {
      serverId: "cursor",
      server: makeServerConfig(),
      worktree,
      openCodeSessionId: "session-1",
    };

    await expect(createSessionKey(base)).resolves.toBe(
      await createSessionKey({ ...base, generation: 0 }),
    );
  });
});
