/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/require-await */
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { ToolContext } from "@opencode-ai/plugin";
import { describe, expect, it, vi } from "vitest";

import { PERMISSION_TOOL_NAME } from "../../src/constants.js";
import {
  PermissionInteractionBroker,
  type PermissionToolInput,
} from "../../src/interactions/permission.js";
import type { PermissionInteraction } from "../../src/worker/messages.js";

const EXPIRES_AT = 20_000;

function permissionRequest(): RequestPermissionRequest {
  return {
    sessionId: "backend-session",
    toolCall: {
      toolCallId: "acp-tool-1",
      title: "Write package.json",
      kind: "edit",
      rawInput: { path: "/repo/package.json" },
    },
    options: [
      { optionId: "yes", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  };
}

function interaction(
  overrides: Partial<PermissionInteraction> = {},
): PermissionInteraction {
  return {
    type: "interaction.permission",
    turnId: "turn-1",
    index: 3,
    interactionId: "interaction-1",
    serverId: "cursor",
    sessionKey: "session-key-1",
    expiresAt: EXPIRES_AT,
    request: permissionRequest(),
    inferredKind: "edit",
    ...overrides,
  };
}

function toolInput(
  overrides: Partial<PermissionToolInput> = {},
): PermissionToolInput {
  return {
    interactionId: "interaction-1",
    serverId: "cursor",
    sessionKey: "session-key-1",
    expiresAt: EXPIRES_AT,
    request: permissionRequest(),
    inferredKind: "edit",
    ...overrides,
  };
}

function context(
  ask: ToolContext["ask"],
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    sessionID: "oc-session-1",
    messageID: "message-1",
    agent: "build",
    directory: "/repo",
    worktree: "/repo",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask,
    ...overrides,
  };
}

function preparedBroker(
  options: { mode?: "ask" | "allow" | "deny"; fallback?: "deny" | "fail" } = {},
) {
  const broker = new PermissionInteractionBroker({
    mode: options.mode ?? "ask",
    fallback: options.fallback ?? "deny",
    now: () => 10_000,
  });
  broker.bindSession("session-key-1", "oc-session-1");
  broker.observeWorkerEvent(interaction(), "cursor");
  broker.beforeToolExecute(
    PERMISSION_TOOL_NAME,
    { tool: PERMISSION_TOOL_NAME, sessionID: "oc-session-1", callID: "call-1" },
    toolInput(),
  );
  return broker;
}

function parsedDecision(
  result: Awaited<ReturnType<PermissionInteractionBroker["execute"]>>,
) {
  if (typeof result === "string")
    throw new Error("Expected structured tool result");
  return JSON.parse(result.output) as {
    interactionId: string;
    decision: { outcome: string };
  };
}

describe("PermissionInteractionBroker", () => {
  it.each([
    ["once", "allow_once"],
    ["always", "allow_always"],
    ["reject", "reject_once"],
  ] as const)("correlates an exact %s reply", async (reply, outcome) => {
    const broker = preparedBroker();
    const ask = vi.fn(async () => {
      broker.ingestRuntimeEvent({
        type: "permission.asked",
        properties: {
          id: "permission-1",
          sessionID: "oc-session-1",
          permission: "acp.cursor.edit",
          patterns: ["/repo/package.json"],
          always: ["/repo/package.json"],
          metadata: {},
          tool: { messageID: "message-1", callID: "call-1" },
        },
      });
      broker.ingestRuntimeEvent({
        type: "permission.replied",
        properties: {
          sessionID: "oc-session-1",
          requestID: "permission-1",
          reply,
        },
      });
      if (reply === "reject") throw new Error("Permission rejected");
    });

    const result = parsedDecision(
      await broker.execute(toolInput(), context(ask)),
    );

    expect(result).toEqual({
      interactionId: "interaction-1",
      decision: { outcome },
    });
    expect(ask).toHaveBeenCalledWith({
      permission: "acp.cursor.edit",
      patterns: ["/repo/package.json"],
      always: ["/repo/package.json"],
      metadata: {
        title: "Write package.json",
        acpServer: "cursor",
        acpToolKind: "edit",
      },
    });
  });

  it("ignores replies for another call, request, or session", async () => {
    const broker = preparedBroker();
    const result = await broker.execute(
      toolInput(),
      context(async () => {
        broker.ingestRuntimeEvent({
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "other-session",
            permission: "acp.cursor.edit",
            patterns: [],
            always: [],
            metadata: {},
            tool: { messageID: "message-1", callID: "call-1" },
          },
        });
        broker.ingestRuntimeEvent({
          type: "permission.replied",
          properties: {
            sessionID: "oc-session-1",
            requestID: "other-request",
            reply: "always",
          },
        });
      }),
    );

    expect(parsedDecision(result).decision.outcome).toBe("allow_once");
  });

  it("fails closed for a fabricated interaction", async () => {
    const broker = preparedBroker();
    const ask = vi.fn(async () => {});

    const result = await broker.execute(
      toolInput({ interactionId: "fabricated" }),
      context(ask),
    );

    expect(parsedDecision(result).decision.outcome).toBe("cancel");
    expect(ask).not.toHaveBeenCalled();
  });

  it("fails closed when tool.execute.before did not bind the call", async () => {
    const broker = new PermissionInteractionBroker({
      mode: "ask",
      fallback: "deny",
      now: () => 10_000,
    });
    broker.bindSession("session-key-1", "oc-session-1");
    broker.observeWorkerEvent(interaction(), "cursor");
    const ask = vi.fn(async () => {});

    const result = await broker.execute(toolInput(), context(ask));

    expect(parsedDecision(result).decision.outcome).toBe("cancel");
    expect(ask).not.toHaveBeenCalled();
  });

  it("maps automatic OpenCode approval to allow-once", async () => {
    const broker = preparedBroker();
    const result = await broker.execute(
      toolInput(),
      context(async () => {}),
    );
    expect(parsedDecision(result).decision.outcome).toBe("allow_once");
  });

  it("uses configured non-interactive policies without opening a prompt", async () => {
    const allow = preparedBroker({ mode: "allow" });
    const deny = preparedBroker({ mode: "deny" });
    const ask = vi.fn(async () => {});

    expect(
      parsedDecision(await allow.execute(toolInput(), context(ask))).decision
        .outcome,
    ).toBe("allow_once");
    expect(
      parsedDecision(await deny.execute(toolInput(), context(ask))).decision
        .outcome,
    ).toBe("reject_once");
    expect(ask).not.toHaveBeenCalled();
  });

  it("cancels when no corresponding ACP option is available", async () => {
    const pending = interaction({
      request: { ...permissionRequest(), options: [] },
    });
    const isolated = new PermissionInteractionBroker({
      mode: "allow",
      fallback: "deny",
      now: () => 10_000,
    });
    isolated.bindSession("session-key-1", "oc-session-1");
    isolated.observeWorkerEvent(pending, "cursor");
    isolated.beforeToolExecute(
      PERMISSION_TOOL_NAME,
      {
        tool: PERMISSION_TOOL_NAME,
        sessionID: "oc-session-1",
        callID: "call-1",
      },
      toolInput(),
    );

    const result = await isolated.execute(
      toolInput(),
      context(async () => {}),
    );
    expect(parsedDecision(result).decision.outcome).toBe("cancel");
  });

  it("cancels an aborted prompt", async () => {
    const broker = preparedBroker();
    const abort = new AbortController();
    abort.abort(new Error("turn cancelled"));

    const result = await broker.execute(
      toolInput(),
      context(() => new Promise<void>(() => {}), { abort: abort.signal }),
    );
    expect(parsedDecision(result).decision.outcome).toBe("cancel");
  });

  it("returns and removes session keys on a V2 session deletion event", () => {
    const broker = preparedBroker();
    expect(
      broker.deletedSessionKeys({
        type: "session.deleted",
        properties: { sessionID: "oc-session-1", info: { id: "oc-session-1" } },
      }),
    ).toEqual(["session-key-1"]);
    expect(broker.deleteSession("oc-session-1")).toEqual([]);
  });
});
