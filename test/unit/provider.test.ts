import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type { AcpPermissionDecision } from "acpx/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PERMISSION_TOOL_NAME } from "../../src/constants.js";
import { createOpencodeAcpx } from "../../src/provider.js";
import {
  registerProviderRuntime,
  unregisterProviderRuntime,
} from "../../src/registry.js";
import { TurnChannel } from "../../src/worker/turn-channel.js";
import type { TurnStartParams } from "../../src/worker/messages.js";
import type { RuntimeWorkerEvent } from "../../src/worker/messages.js";
import { makeServerConfig } from "../helpers/config.js";

const registered: [string, string][] = [];

afterEach(() => {
  for (const [pluginInstanceId, providerId] of registered.splice(0)) {
    unregisterProviderRuntime(pluginInstanceId, providerId);
  }
});

class FakeWorkerClient {
  readonly starts: TurnStartParams[] = [];
  readonly channels = new Map<string, TurnChannel>();
  readonly listeners = new Set<(event: RuntimeWorkerEvent) => void>();
  readonly cancelTurn = vi.fn(() => Promise.resolve(undefined));
  readonly respondPermission = vi.fn(
    (interactionId: string, decision: AcpPermissionDecision) => {
      void interactionId;
      void decision;
      return Promise.resolve(undefined);
    },
  );
  readonly respondElicitation = vi.fn(
    (interactionId: string, response: unknown) => {
      void interactionId;
      void response;
      return Promise.resolve(undefined);
    },
  );
  readonly respondExtension = vi.fn((params: unknown) => {
    void params;
    return Promise.resolve(undefined);
  });
  readonly closeSession = vi.fn(() => Promise.resolve(undefined));
  onStart?: (params: TurnStartParams, channel: TurnChannel) => void;

  subscribe(listener: (event: RuntimeWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeWorkerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  startTurn(params: TurnStartParams): Promise<TurnChannel> {
    const existing = this.channels.get(params.turnId);
    if (existing !== undefined) return Promise.resolve(existing);
    this.starts.push(params);
    const channel = new TurnChannel(params.turnId);
    this.channels.set(params.turnId, channel);
    queueMicrotask(() => this.onStart?.(params, channel));
    return Promise.resolve(channel);
  }
}

function setup(providerId = "acp.cursor.work", modelId = "cursor-model") {
  const pluginInstanceId = `plugin-${String(registered.length + 1)}-${providerId}`;
  const client = new FakeWorkerClient();
  registerProviderRuntime({
    pluginInstanceId,
    providerId,
    client,
    serverId: "cursor",
    server: makeServerConfig(),
    directory: process.cwd(),
    worktree: process.cwd(),
  });
  registered.push([pluginInstanceId, providerId]);
  const model = createOpencodeAcpx({
    name: providerId,
    pluginInstanceId,
    serverId: "cursor",
  }).languageModel(modelId);
  return { client, model, providerId };
}

function call(
  providerId: string,
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello ACP" }] }],
    providerOptions: {
      [providerId]: { openCodeSessionId: "session-1", requestId: "message-1" },
    },
    ...overrides,
  };
}

async function readStream(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe("OpenCode Acpx language provider", () => {
  it("lets the ACP agent choose its default model for the synthetic default entry", async () => {
    const { client, model, providerId } = setup(
      "acp.cursor.default",
      "default",
    );
    client.onStart = (params, channel) => {
      channel.push({
        type: "turn.result",
        turnId: params.turnId,
        index: 0,
        result: { status: "completed", stopReason: "end_turn" },
      });
    };

    await readStream((await model.doStream(call(providerId))).stream);

    expect(client.starts).toHaveLength(1);
    expect(client.starts[0]).not.toHaveProperty("modelId");
  });

  it("isolates and discards OpenCode internal title sessions", async () => {
    const { client, model, providerId } = setup("acp.cursor.title", "default");
    client.onStart = (params, channel) => {
      channel.push({
        type: "turn.result",
        turnId: params.turnId,
        index: 0,
        result: { status: "completed", stopReason: "end_turn" },
      });
    };

    await readStream(
      (
        await model.doStream(
          call(providerId, {
            providerOptions: {
              [providerId]: {
                openCodeSessionId: "session-1",
                requestId: "title-message-1",
                agent: "title",
              },
            },
          }),
        )
      ).stream,
    );

    expect(client.closeSession).toHaveBeenCalledOnce();
    expect(client.closeSession).toHaveBeenCalledWith(
      "cursor",
      client.starts[0]?.sessionKey,
      true,
    );
  });

  it("routes dotted providers and replays a stable turn without starting it twice", async () => {
    const { client, model, providerId } = setup();
    client.onStart = (params, channel) => {
      channel.push({
        type: "turn.event",
        turnId: params.turnId,
        index: 0,
        event: { type: "text_delta", text: "Hello", stream: "output" },
      });
      channel.push({
        type: "turn.result",
        turnId: params.turnId,
        index: 1,
        result: { status: "completed", stopReason: "end_turn" },
      });
    };

    const first = await readStream(
      (await model.doStream(call(providerId))).stream,
    );
    const replay = await readStream(
      (await model.doStream(call(providerId))).stream,
    );

    expect(client.starts).toHaveLength(1);
    expect(client.starts[0]).toMatchObject({
      serverId: "cursor",
      requestId: "message-1",
      text: "Hello ACP",
      modelId: "cursor-model",
    });
    expect(replay).toEqual(first);
  });

  it("pauses for an ordinary permission tool and resumes the same channel exactly once", async () => {
    const { client, model, providerId } = setup("acp.cursor.permission");
    client.onStart = (params, channel) => {
      channel.push({
        type: "interaction.permission",
        turnId: params.turnId,
        index: 0,
        interactionId: "interaction-1",
        serverId: "cursor",
        sessionKey: params.sessionKey,
        expiresAt: Date.now() + 60_000,
        request: {
          sessionId: "backend-session-1",
          toolCall: { toolCallId: "remote-tool-1", title: "Run command" },
          options: [],
        },
        inferredKind: "execute",
      });
    };
    client.respondPermission.mockImplementation(() => {
      const channel = [...client.channels.values()][0];
      if (channel === undefined) throw new Error("missing channel");
      channel.push({
        type: "turn.event",
        turnId: channel.turnId,
        index: 1,
        event: { type: "text_delta", text: "Approved", stream: "output" },
      });
      channel.push({
        type: "turn.result",
        turnId: channel.turnId,
        index: 2,
        result: { status: "completed" },
      });
      return Promise.resolve(undefined);
    });

    const first = await readStream(
      (await model.doStream(call(providerId))).stream,
    );
    const permission = first.find((part) => part.type === "tool-call");
    if (permission?.type !== "tool-call")
      throw new Error("missing permission call");
    expect(permission).toMatchObject({
      toolName: PERMISSION_TOOL_NAME,
      providerExecuted: false,
    });

    const continuation = call(providerId, {
      prompt: [
        { role: "user", content: [{ type: "text", text: "Hello ACP" }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: permission.toolCallId,
              toolName: PERMISSION_TOOL_NAME,
              output: {
                type: "json",
                value: {
                  interactionId: "interaction-1",
                  decision: { outcome: "allow_once" },
                },
              },
            },
          ],
        },
      ],
    });
    const second = await readStream(
      (await model.doStream(continuation)).stream,
    );

    expect(client.starts).toHaveLength(1);
    expect(client.respondPermission).toHaveBeenCalledTimes(1);
    expect(client.respondPermission).toHaveBeenCalledWith("interaction-1", {
      outcome: "allow_once",
    });
    expect(second).toContainEqual(
      expect.objectContaining({ type: "text-delta", delta: "Approved" }),
    );
  });

  it("forwards stream cancellation to the worker", async () => {
    const { client, model, providerId } = setup("acp.cursor.cancel");
    const result = await model.doStream(call(providerId));
    const reader = result.stream.getReader();
    await reader.cancel("user stopped");

    expect(client.cancelTurn).toHaveBeenCalledTimes(1);
    expect(client.cancelTurn).toHaveBeenCalledWith(
      expect.any(String),
      "user stopped",
    );
  });

  it("segments elicitation fallback and responds exactly once on continuation", async () => {
    const { client, model, providerId } = setup("acp.cursor.elicitation");
    client.onStart = (params) => {
      client.emit({
        type: "interaction.elicitation",
        turnId: params.turnId,
        interactionId: "elicitation-1",
        serverId: "cursor",
        sessionKey: params.sessionKey,
        expiresAt: Date.now() + 60_000,
        request: {
          mode: "url",
          message: "Open the authentication page",
          elicitationId: "auth-1",
          url: "https://example.test/auth",
        },
      });
    };
    client.respondElicitation.mockImplementation(() => {
      const channel = [...client.channels.values()][0];
      if (channel === undefined) throw new Error("missing channel");
      channel.push({
        type: "turn.result",
        turnId: channel.turnId,
        index: 0,
        result: { status: "completed" },
      });
      return Promise.resolve(undefined);
    });

    const first = await readStream(
      (await model.doStream(call(providerId))).stream,
    );
    const interaction = first.find(
      (part) =>
        part.type === "tool-call" &&
        part.toolName === "opencode_acp_interaction",
    );
    if (interaction?.type !== "tool-call")
      throw new Error("missing interaction call");
    const continuation = call(providerId, {
      prompt: [
        { role: "user", content: [{ type: "text", text: "Hello ACP" }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: interaction.toolCallId,
              toolName: interaction.toolName,
              output: {
                type: "json",
                value: {
                  interactionId: "elicitation-1",
                  method: "elicitation/create",
                  response: { action: "cancel" },
                },
              },
            },
          ],
        },
      ],
    });
    await readStream((await model.doStream(continuation)).stream);

    expect(client.respondElicitation).toHaveBeenCalledTimes(1);
    expect(client.respondElicitation).toHaveBeenCalledWith("elicitation-1", {
      action: "cancel",
    });
  });

  it("segments extension fallback and returns its correlated result exactly once", async () => {
    const { client, model, providerId } = setup("acp.cursor.extension");
    client.onStart = (params) => {
      client.emit({
        type: "interaction.extension",
        turnId: params.turnId,
        interactionId: "plan-1",
        serverId: "cursor",
        sessionKey: params.sessionKey,
        expiresAt: Date.now() + 60_000,
        method: "cursor/create_plan",
        params: { name: "Implement ACP" },
      });
    };
    client.respondExtension.mockImplementation(() => {
      const channel = [...client.channels.values()][0];
      if (channel === undefined) throw new Error("missing channel");
      channel.push({
        type: "turn.result",
        turnId: channel.turnId,
        index: 0,
        result: { status: "completed" },
      });
      return Promise.resolve(undefined);
    });

    const first = await readStream(
      (await model.doStream(call(providerId))).stream,
    );
    const interaction = first.find(
      (part) =>
        part.type === "tool-call" &&
        part.toolName === "opencode_acp_interaction",
    );
    if (interaction?.type !== "tool-call")
      throw new Error("missing interaction call");
    const continuation = call(providerId, {
      prompt: [
        { role: "user", content: [{ type: "text", text: "Hello ACP" }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: interaction.toolCallId,
              toolName: interaction.toolName,
              output: {
                type: "json",
                value: {
                  interactionId: "plan-1",
                  method: "cursor/create_plan",
                  result: { outcome: { outcome: "accepted" } },
                },
              },
            },
          ],
        },
      ],
    });
    await readStream((await model.doStream(continuation)).stream);

    expect(client.respondExtension).toHaveBeenCalledTimes(1);
    expect(client.respondExtension).toHaveBeenCalledWith({
      interactionId: "plan-1",
      result: { outcome: { outcome: "accepted" } },
    });
  });

  it("collects reasoning, text, remote tools, finish and usage through doGenerate", async () => {
    const { client, model, providerId } = setup("acp.cursor.generate");
    client.onStart = (params, channel) => {
      const events = [
        { type: "text_delta", text: "Thinking", stream: "thought" },
        { type: "text_delta", text: "Answer", stream: "output" },
        {
          type: "tool_call",
          text: "Search",
          toolCallId: "tool-1",
          title: "Search",
          kind: "search",
          rawInput: { query: "ACP" },
          status: "pending",
        },
        {
          type: "tool_call",
          text: "Search complete",
          toolCallId: "tool-1",
          title: "Search",
          kind: "search",
          rawOutput: { matches: 2 },
          status: "completed",
        },
        {
          type: "status",
          text: "usage",
          breakdown: { inputTokens: 10, outputTokens: 5, thoughtTokens: 2 },
        },
      ] as const;
      events.forEach((event, index) =>
        channel.push({
          type: "turn.event",
          turnId: params.turnId,
          index,
          event,
        }),
      );
      channel.push({
        type: "turn.result",
        turnId: params.turnId,
        index: events.length,
        result: { status: "completed", stopReason: "end_turn" },
      });
    };

    const result = await model.doGenerate(call(providerId));

    expect(result.content).toEqual(
      expect.arrayContaining([
        { type: "reasoning", text: "Thinking" },
        { type: "text", text: "Answer" },
        expect.objectContaining({ type: "tool-call", providerExecuted: true }),
        expect.objectContaining({
          type: "tool-result",
          result: '{\n  "matches": 2\n}',
        }),
      ]),
    );
    expect(result.finishReason).toEqual({ unified: "stop", raw: "end_turn" });
    expect(result.usage).toMatchObject({
      inputTokens: { total: 10 },
      outputTokens: { total: 5, text: 3, reasoning: 2 },
    });
  });

  it("routes correlated vendor subagent notifications through the provider stream", async () => {
    const { client, model, providerId } = setup("acp.cursor.subagent");
    client.onStart = (params, channel) => {
      channel.push({
        type: "turn.event",
        turnId: params.turnId,
        index: 0,
        event: {
          type: "tool_call",
          text: "Explore",
          toolCallId: "task-1",
          kind: "other",
          rawInput: {
            _toolName: "task",
            prompt: "Inspect files",
            description: "Explore",
            subagentType: "explore",
          },
          status: "in_progress",
        },
      });
      client.emit({
        type: "extension.notification",
        serverId: "cursor",
        sessionKey: params.sessionKey,
        turnId: params.turnId,
        method: "cursor/task",
        params: {
          toolCallId: "task-1",
          description: "Explore",
          prompt: "Inspect files",
          subagentType: "explore",
          durationMs: 100,
        },
      });
      channel.push({
        type: "turn.result",
        turnId: params.turnId,
        index: 1,
        result: { status: "completed", stopReason: "end_turn" },
      });
    };

    const parts = await readStream(
      (await model.doStream(call(providerId))).stream,
    );
    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(1);
    expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
      toolName: "task",
      providerExecuted: true,
    });
    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
      toolName: "task",
      result: { durationMs: 100 },
    });
  });

  it("acknowledges Cursor activity requests without exposing control-tool cards", async () => {
    const { client, model, providerId } = setup("acp.cursor.activity");
    client.onStart = (params) => {
      client.emit({
        type: "interaction.extension",
        turnId: params.turnId,
        interactionId: "cursor-task-1",
        serverId: "cursor",
        sessionKey: params.sessionKey,
        expiresAt: Date.now() + 60_000,
        method: "cursor/task",
        params: {
          toolCallId: "task-1",
          description: "Explore",
          prompt: "Inspect the repository",
          subagentType: "explore",
          durationMs: 42,
        },
      });
    };
    client.respondExtension.mockImplementation(() => {
      const channel = [...client.channels.values()][0];
      if (channel === undefined) throw new Error("missing channel");
      channel.push({
        type: "turn.result",
        turnId: channel.turnId,
        index: 0,
        result: { status: "completed" },
      });
      return Promise.resolve(undefined);
    });

    const parts = await readStream(
      (await model.doStream(call(providerId))).stream,
    );

    expect(client.respondExtension).toHaveBeenCalledWith({
      interactionId: "cursor-task-1",
      result: {},
    });
    expect(parts).toContainEqual(
      expect.objectContaining({ type: "tool-call", toolName: "task" }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({ type: "tool-result", toolName: "task" }),
    );
    expect(
      parts.some(
        (part) =>
          part.type === "tool-call" &&
          part.toolName === "opencode_acp_interaction",
      ),
    ).toBe(false);
  });
});
