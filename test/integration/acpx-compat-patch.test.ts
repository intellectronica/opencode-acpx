import type {
  AnyMessage,
  CreateElicitationRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  ACPX_RUNTIME_COMPAT_HOOKS_VERSION,
  createAcpRuntime,
  createAgentRegistry,
  type AcpRuntimeAuthMetadata,
  type AcpRuntimeRawMessageDirection,
  type AcpSessionRecord,
  type AcpSessionStore,
} from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";

const FAKE_AGENT_SOURCE = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
let promptRequestId;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        sessionCapabilities: { close: true }
      },
      authMethods: []
    }});
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-session", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    promptRequestId = message.id;
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "fake-session",
      update: { sessionUpdate: "available_commands_update", availableCommands: [
        { name: "compact", description: "Compact context", input: { hint: "Optional focus" } }
      ] }
    }});
    send({ jsonrpc: "2.0", id: "cursor-question", method: "cursor/ask_question", params: {
      toolCallId: "question-tool",
      questions: [{ id: "mode", prompt: "Which mode?", options: [{ id: "plan", label: "Plan" }] }]
    }});
    return;
  }
  if (message.id === "cursor-question" && message.result) {
    send({ jsonrpc: "2.0", id: "elicitation", method: "elicitation/create", params: {
      mode: "form",
      sessionId: "fake-session",
      message: "Choose a branch",
      requestedSchema: { type: "object", properties: { branch: { type: "string" } } }
    }});
    return;
  }
  if (message.id === "elicitation" && message.result) {
    send({ jsonrpc: "2.0", method: "cursor/task", params: {
      toolCallId: "task-tool", description: "Explore", prompt: "Inspect files", subagentType: "explore"
    }});
    send({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
`;

describe("patched Acpx runtime compatibility hooks", () => {
  it("exposes the marker and carries raw, update, extension, and elicitation traffic", async () => {
    expect(ACPX_RUNTIME_COMPAT_HOOKS_VERSION).toBe(1);
    const store = createMemoryStore();
    const rawMessages: {
      direction: AcpRuntimeRawMessageDirection;
      message: AnyMessage;
    }[] = [];
    const updates: SessionNotification[] = [];
    const extensionRequests: { method: string; params: unknown }[] = [];
    const extensionNotifications: { method: string; params: unknown }[] = [];
    const authMetadata: AcpRuntimeAuthMetadata[] = [];
    const elicitation = vi.fn((_request: CreateElicitationRequest) => {
      void _request;
      return Promise.resolve({
        action: "accept" as const,
        content: { branch: "main" },
      });
    });
    const runtime = createAcpRuntime({
      cwd: process.cwd(),
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: { fake: [process.execPath, "-e", FAKE_AGENT_SOURCE] },
      }),
      permissionMode: "deny-all",
      timeoutMs: 5_000,
      onRawMessage: (direction, message) => {
        rawMessages.push({ direction, message });
      },
      onSessionUpdate: (notification) => {
        updates.push(notification);
      },
      onElicitationRequest: (request) => elicitation(request),
      onExtensionRequest: (method, params) => {
        extensionRequests.push({ method, params });
        return Promise.resolve({
          outcome: {
            outcome: "answered",
            answers: [{ questionId: "mode", selectedOptionIds: ["plan"] }],
          },
        });
      },
      onExtensionNotification: (method, params) => {
        extensionNotifications.push({ method, params });
      },
      onAuthMetadata: (metadata) => {
        authMetadata.push(metadata);
      },
    });

    const handle = await runtime.ensureSession({
      sessionKey: "patch-integration",
      agent: "fake",
      mode: "persistent",
      cwd: process.cwd(),
    });
    const turn = runtime.startTurn({
      handle,
      text: "exercise compatibility hooks",
      mode: "prompt",
      requestId: "request-1",
    });
    for await (const _event of turn.events) {
      void _event;
    }

    await expect(turn.result).resolves.toEqual({
      status: "completed",
      stopReason: "end_turn",
    });
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ input: { hint: "Optional focus" } }],
    });
    expect(extensionRequests).toHaveLength(1);
    expect(extensionRequests[0]?.method).toBe("cursor/ask_question");
    expect(extensionRequests[0]?.params).toMatchObject({
      toolCallId: "question-tool",
    });
    expect(elicitation).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "form", message: "Choose a branch" }),
    );
    expect(extensionNotifications).toHaveLength(1);
    expect(extensionNotifications[0]?.method).toBe("cursor/task");
    expect(extensionNotifications[0]?.params).toMatchObject({
      toolCallId: "task-tool",
    });
    expect(authMetadata[0]).toEqual({ status: "advertised", authMethods: [] });
    expect(rawMessages.some(({ direction }) => direction === "inbound")).toBe(
      true,
    );
    expect(rawMessages.some(({ direction }) => direction === "outbound")).toBe(
      true,
    );

    await runtime.close({
      handle,
      reason: "test complete",
      discardPersistentState: true,
    });
  });
});

function createMemoryStore(): AcpSessionStore {
  const records = new Map<string, AcpSessionRecord>();
  return {
    load: (sessionId) => Promise.resolve(records.get(sessionId)),
    save: (record) => {
      records.set(record.acpxRecordId, structuredClone(record));
      return Promise.resolve();
    },
  };
}
