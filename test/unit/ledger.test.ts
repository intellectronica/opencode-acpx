import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BindingLedger,
  createBindingRecord,
} from "../../src/session/ledger.js";

async function fixture(): Promise<{ ledger: BindingLedger; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-acpx-ledger-"));
  const path = join(directory, "bindings.json");
  return { ledger: new BindingLedger({ path }), path };
}

describe("BindingLedger", () => {
  it("persists private, schema-validated binding state", async () => {
    const { ledger, path } = await fixture();
    const binding = createBindingRecord({
      sessionKey: "session-key",
      serverId: "cursor",
      openCodeSessionId: "oc-session",
      worktree: "/repo",
    });
    await ledger.put("binding", binding);

    await expect(ledger.get("binding")).resolves.toMatchObject({
      serverId: "cursor",
      generation: 0,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schema: 1,
    });
  });

  it("distinguishes start, join, replay and unsafe retry outcomes", async () => {
    const { ledger } = await fixture();
    await ledger.put(
      "binding",
      createBindingRecord({
        sessionKey: "session-key",
        serverId: "cursor",
        openCodeSessionId: "oc-session",
        worktree: "/repo",
      }),
    );

    await expect(ledger.beginTurn("binding", "message-1")).resolves.toEqual({
      kind: "start",
    });
    await expect(
      ledger.beginTurn("binding", "message-1"),
    ).resolves.toMatchObject({ kind: "join" });
    await ledger.record("binding", "message-1", {
      cursor: 3,
      replay: [{ type: "text" }],
    });
    await ledger.finishTurn("binding", "message-1", "completed");
    await expect(
      ledger.beginTurn("binding", "message-1"),
    ).resolves.toMatchObject({ kind: "replay" });

    await expect(ledger.beginTurn("binding", "message-2")).resolves.toEqual({
      kind: "start",
    });
    await ledger.record("binding", "message-2", {
      cursor: 1,
      unsafeToRetry: true,
    });
    await ledger.finishTurn(
      "binding",
      "message-2",
      "failed",
      "tool may have run",
    );
    await expect(
      ledger.beginTurn("binding", "message-2"),
    ).resolves.toMatchObject({ kind: "unsafe" });
  });

  it("serialises concurrent mutations without losing bindings", async () => {
    const { ledger } = await fixture();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        ledger.put(
          `binding-${String(index)}`,
          createBindingRecord({
            sessionKey: `session-${String(index)}`,
            serverId: "fixture",
            openCodeSessionId: `oc-${String(index)}`,
            worktree: "/repo",
          }),
        ),
      ),
    );
    await expect(
      Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          ledger.get(`binding-${String(index)}`),
        ),
      ),
    ).resolves.toHaveLength(12);
    for (let index = 0; index < 12; index += 1) {
      await expect(
        ledger.get(`binding-${String(index)}`),
      ).resolves.toMatchObject({
        sessionKey: `session-${String(index)}`,
      });
    }
  });

  it("removes only the requested binding", async () => {
    const { ledger } = await fixture();
    const binding = createBindingRecord({
      sessionKey: "session-key",
      serverId: "fixture",
      openCodeSessionId: "oc-session",
      worktree: "/repo",
    });
    await ledger.put("first", binding);
    await ledger.put("second", { ...binding, sessionKey: "other" });
    await ledger.remove("first");
    await expect(ledger.get("first")).resolves.toBeUndefined();
    await expect(ledger.get("second")).resolves.toMatchObject({
      sessionKey: "other",
    });
  });
});
