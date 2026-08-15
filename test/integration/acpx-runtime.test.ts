import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
} from "acpx/runtime";
import { describe, expect, it } from "vitest";

import { createDeferred } from "../helpers/deferred.js";

const fixtureAgent = join(process.cwd(), "test/fixtures/fake-acp-agent.mjs");

async function runtime(
  onPermissionRequest?: (
    request: AcpPermissionRequest,
  ) => Promise<AcpPermissionDecision>,
): Promise<AcpRuntime> {
  const stateDir = await mkdtemp(join(tmpdir(), "opencode-acpx-runtime-"));
  return createAcpRuntime({
    cwd: process.cwd(),
    sessionStore: createRuntimeStore({ stateDir }),
    agentRegistry: createAgentRegistry({
      overrides: { fixture: [process.execPath, fixtureAgent] },
    }),
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    ...(onPermissionRequest === undefined ? {} : { onPermissionRequest }),
  });
}

async function session(
  instance: AcpRuntime,
  key: string,
): Promise<AcpRuntimeHandle> {
  return instance.ensureSession({
    sessionKey: key,
    agent: "fixture",
    mode: "persistent",
    cwd: process.cwd(),
  });
}

async function close(
  instance: AcpRuntime,
  handle: AcpRuntimeHandle,
): Promise<void> {
  await instance.close({
    handle,
    reason: "test complete",
    discardPersistentState: true,
  });
}

describe("pinned Acpx runtime with a real ACP stdio child", () => {
  it("persists uppercase environment variable names in session options", async () => {
    const instance = await runtime();
    const handle = await instance.ensureSession({
      sessionKey: "environment",
      agent: "fixture",
      mode: "persistent",
      cwd: process.cwd(),
      sessionOptions: { env: { FAKE_ACP_ENV: "present" } },
    });

    expect(handle.sessionKey).toBe("environment");
    await close(instance, handle);
  });

  it("discovers dynamic models, config options and commands", async () => {
    const instance = await runtime();
    const handle = await session(instance, "catalogue");
    const status = await instance.getStatus?.({ handle });

    expect(status?.models).toEqual({
      currentModelId: "fake-default",
      availableModelIds: ["fake-default", "fake-reasoning"],
    });
    expect(status?.details?.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "model" }),
        expect.objectContaining({ id: "mode" }),
      ]),
    );
    expect(status?.availableCommands).toBeUndefined();
    await close(instance, handle);
  });

  it("streams thought, provider-owned tools, text and usage", async () => {
    const instance = await runtime();
    const handle = await session(instance, "stream");
    const turn = instance.startTurn({
      handle,
      text: "hello",
      mode: "prompt",
      requestId: "message-1",
    });
    const events: AcpRuntimeEvent[] = [];
    for await (const event of turn.events) events.push(event);

    await expect(turn.result).resolves.toEqual({
      status: "completed",
      stopReason: "end_turn",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text_delta",
          stream: "thought",
          text: "thought:1",
        }),
        expect.objectContaining({
          type: "tool_call",
          status: "in_progress",
          kind: "read",
        }),
        expect.objectContaining({
          type: "tool_call",
          status: "completed",
          rawOutput: { ok: true, turn: 1 },
        }),
        expect.objectContaining({
          type: "text_delta",
          stream: "output",
          text: "echo:hello",
        }),
      ]),
    );
    const usage = events.find(
      (event) => event.type === "status" && event.tag === "usage_update",
    );
    expect(
      usage?.type === "status" ? usage.breakdown : undefined,
    ).toMatchObject({ inputTokens: 3, outputTokens: 5 });
    await expect(instance.getStatus?.({ handle })).resolves.toMatchObject({
      availableCommands: [
        expect.objectContaining({
          name: "fixture",
          description: "Run the fixture command",
        }),
      ],
    });
    await close(instance, handle);
  });

  it("blocks on a permission and selects an exact offered option", async () => {
    const requested = createDeferred<AcpPermissionRequest>();
    const decision = createDeferred<AcpPermissionDecision>();
    const instance = await runtime(async (request) => {
      requested.resolve(request);
      return decision.promise;
    });
    const handle = await session(instance, "permission");
    const turn = instance.startTurn({
      handle,
      text: "permission please",
      mode: "prompt",
      requestId: "message-permission",
    });
    const eventsPromise = (async () => {
      const events: AcpRuntimeEvent[] = [];
      for await (const event of turn.events) events.push(event);
      return events;
    })();

    const permissionRequest = await requested.promise;
    expect(permissionRequest.inferredKind).toBe("edit");
    if (!isRecord(permissionRequest.raw))
      throw new Error("permission request has no raw payload");
    const offeredOptions = permissionRequest.raw.options;
    if (!Array.isArray(offeredOptions))
      throw new Error("permission request has no offered options");
    expect(offeredOptions).toContainEqual(
      expect.objectContaining({ optionId: "allow-always" }),
    );
    decision.resolve({ outcome: "allow_always" });

    const events = await eventsPromise;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "text_delta",
        text: "permission:allow-always",
      }),
    );
    await expect(turn.result).resolves.toMatchObject({ status: "completed" });
    await close(instance, handle);
  });

  it("cancels the semantic ACP turn and remains reusable", async () => {
    const instance = await runtime();
    const handle = await session(instance, "cancel");
    const turn = instance.startTurn({
      handle,
      text: "wait-cancel",
      mode: "prompt",
      requestId: "message-cancel",
    });
    let firstThought = false;
    for await (const event of turn.events) {
      firstThought = event.type === "text_delta" && event.stream === "thought";
      if (firstThought) break;
    }
    expect(firstThought).toBe(true);
    await turn.cancel({ reason: "test cancellation" });
    await expect(turn.result).resolves.toMatchObject({ status: "cancelled" });

    const next = instance.startTurn({
      handle,
      text: "after cancellation",
      mode: "prompt",
      requestId: "message-after-cancel",
    });
    for await (const event of next.events) {
      // Drain the real ACP stream before reading its terminal result.
      expect(event).toBeDefined();
    }
    await expect(next.result).resolves.toMatchObject({ status: "completed" });
    await close(instance, handle);
  });

  it("keeps concurrent session histories isolated", async () => {
    const instance = await runtime();
    const [left, right] = await Promise.all([
      session(instance, "left"),
      session(instance, "right"),
    ]);
    const run = async (handle: AcpRuntimeHandle, text: string) => {
      const turn = instance.startTurn({
        handle,
        text,
        mode: "prompt",
        requestId: `message-${text}`,
      });
      const output: string[] = [];
      for await (const event of turn.events) {
        if (event.type === "text_delta" && event.stream === "output")
          output.push(event.text);
      }
      await turn.result;
      return output;
    };

    const [leftOutput, rightOutput] = await Promise.all([
      run(left, "left-only"),
      run(right, "right-only"),
    ]);
    expect(leftOutput).toContain("echo:left-only");
    expect(leftOutput).not.toContain("echo:right-only");
    expect(rightOutput).toContain("echo:right-only");
    expect(rightOutput).not.toContain("echo:left-only");
    await Promise.all([close(instance, left), close(instance, right)]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
