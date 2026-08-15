import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { PERMISSION_TOOL_NAME } from "../../src/constants.js";
import { AcpStreamTranslator } from "../../src/translate/stream.js";

function types(parts: LanguageModelV3StreamPart[]): string[] {
  return parts.map((part) => part.type);
}

describe("ACP stream translation", () => {
  it("segments interleaved reasoning and output text", () => {
    const translator = new AcpStreamTranslator("turn-1");
    const parts = [
      ...translator.event(
        { type: "text_delta", text: "think", stream: "thought" },
        0,
      ),
      ...translator.event(
        { type: "text_delta", text: "answer", stream: "output" },
        1,
      ),
      ...translator.terminal({ status: "completed", stopReason: "end_turn" }),
    ];

    expect(types(parts)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  it("emits remote tools as provider-executed calls and results", () => {
    const translator = new AcpStreamTranslator("turn-1");
    const parts = [
      ...translator.event(
        {
          type: "tool_call",
          text: "Read file",
          toolCallId: "remote-1",
          title: "Read file",
          kind: "read",
          rawInput: { path: "README.md" },
          status: "pending",
        },
        0,
      ),
      ...translator.event(
        {
          type: "tool_call",
          text: "Read file (completed)",
          toolCallId: "remote-1",
          title: "Read file",
          kind: "read",
          rawOutput: { text: "hello" },
          status: "completed",
        },
        1,
      ),
    ];
    const call = parts.find((part) => part.type === "tool-call");
    const result = parts.find((part) => part.type === "tool-result");

    expect(call).toMatchObject({
      toolCallId: "turn-1-tool-remote-1",
      toolName: "read",
      providerExecuted: true,
      dynamic: true,
    });
    if (call?.type !== "tool-call") throw new Error("missing tool call");
    expect(JSON.parse(call.input)).toEqual({ filePath: "README.md" });
    expect(result).toMatchObject({
      toolCallId: "turn-1-tool-remote-1",
      result: { loaded: ["README.md"] },
    });
  });

  it("surfaces permission interactions as ordinary tool calls", () => {
    const translator = new AcpStreamTranslator("turn-1");
    const parts = translator.permission({
      type: "interaction.permission",
      turnId: "turn-1",
      index: 0,
      interactionId: "interaction-1",
      serverId: "cursor",
      sessionKey: "session-1",
      expiresAt: 123,
      request: {
        sessionId: "backend-session-1",
        toolCall: { toolCallId: "remote-tool-1", title: "Run command" },
        options: [],
      },
      inferredKind: "execute",
    });
    const call = parts.find((part) => part.type === "tool-call");
    const finish = parts.find((part) => part.type === "finish");

    expect(call).toMatchObject({
      toolName: PERMISSION_TOOL_NAME,
      providerExecuted: false,
    });
    if (call?.type !== "tool-call") throw new Error("missing permission call");
    expect(call.input).toContain('"serverId":"cursor"');
    expect(finish).toMatchObject({ finishReason: { unified: "tool-calls" } });
  });

  it("maps the latest Acpx usage breakdown onto AI SDK usage", () => {
    const translator = new AcpStreamTranslator("turn-1");
    translator.event(
      {
        type: "status",
        text: "usage",
        breakdown: {
          inputTokens: 100,
          outputTokens: 30,
          cachedReadTokens: 20,
          cachedWriteTokens: 10,
          thoughtTokens: 5,
        },
      },
      0,
    );
    const finish = translator
      .terminal({ status: "completed" })
      .find((part) => part.type === "finish");

    expect(finish).toMatchObject({
      usage: {
        inputTokens: { total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 },
        outputTokens: { total: 30, text: 25, reasoning: 5 },
      },
    });
  });

  it("projects Cursor task notifications as native task cards without duplicating a standard call", () => {
    const translator = new AcpStreamTranslator("turn-1");
    const initial = translator.event(
      {
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
      0,
    );
    const completed = translator.extensionNotification({
      type: "extension.notification",
      serverId: "cursor",
      sessionKey: "session-1",
      turnId: "turn-1",
      method: "cursor/task",
      params: {
        toolCallId: "task-1",
        description: "Explore",
        prompt: "Inspect files",
        subagentType: "explore",
        durationMs: 100,
      },
    });

    expect(initial.filter((part) => part.type === "tool-call")).toHaveLength(1);
    expect(initial.find((part) => part.type === "tool-call")).toMatchObject({
      toolName: "task",
    });
    expect(completed.filter((part) => part.type === "tool-call")).toHaveLength(
      0,
    );
    expect(completed.find((part) => part.type === "tool-result")).toMatchObject(
      {
        toolName: "task",
        result: { durationMs: 100 },
      },
    );
  });

  it("enriches a completed Cursor task with request metadata before rendering it", () => {
    const translator = new AcpStreamTranslator("turn-1");
    const generic = translator.event(
      {
        type: "tool_call",
        text: "Task: Subagent task",
        title: "Task: Subagent task",
        toolCallId: "task-1",
        kind: "other",
        rawInput: { _toolName: "task" },
        status: "completed",
      },
      0,
    );
    const enriched = translator.extensionNotification({
      type: "extension.notification",
      serverId: "cursor",
      sessionKey: "session-1",
      turnId: "turn-1",
      method: "cursor/task",
      params: {
        toolCallId: "task-1",
        description: "Explore ACP runtime",
        prompt: "Inspect the repository",
        subagentType: "explore",
        durationMs: 100,
      },
    });

    expect(generic.some((part) => part.type === "tool-call")).toBe(false);
    expect(enriched.find((part) => part.type === "tool-call")).toMatchObject({
      toolName: "task",
      input: JSON.stringify({
        prompt: "Inspect the repository",
        description: "Explore ACP runtime",
        subagent_type: "explore",
      }),
    });
    expect(enriched.find((part) => part.type === "tool-result")).toMatchObject({
      toolName: "task",
      result: { durationMs: 100 },
    });
  });

  it("flushes a deferred task safely when no vendor lifecycle arrives", () => {
    const translator = new AcpStreamTranslator("turn-1");
    const deferred = translator.event(
      {
        type: "tool_call",
        text: "Task: Subagent task",
        toolCallId: "task-1",
        kind: "other",
        rawInput: { _toolName: "task" },
        status: "completed",
      },
      0,
    );
    const terminal = translator.terminal({ status: "completed" });

    expect(deferred).toEqual([]);
    expect(terminal.find((part) => part.type === "tool-call")).toMatchObject({
      toolName: "task",
    });
    expect(terminal.find((part) => part.type === "tool-result")).toMatchObject({
      toolName: "task",
    });
  });

  it("does not turn deferred in-progress task activity into a false result", () => {
    const translator = new AcpStreamTranslator("turn-1");
    translator.event(
      {
        type: "tool_call",
        text: "Task: Subagent task (pending)",
        toolCallId: "task-1",
        kind: "other",
        rawInput: { _toolName: "task" },
        status: "pending",
      },
      0,
    );
    const nextText = translator.event(
      { type: "text_delta", text: "Continuing", stream: "output" },
      1,
    );

    expect(nextText.find((part) => part.type === "tool-call")).toMatchObject({
      toolName: "task",
    });
    expect(nextText.some((part) => part.type === "tool-result")).toBe(false);
  });

  it("keeps a Grok subagent task running from spawn until finish", () => {
    const translator = new AcpStreamTranslator("turn-1");
    const spawn = translator.extensionNotification({
      type: "extension.notification",
      serverId: "grok-build",
      sessionKey: "session-1",
      turnId: "turn-1",
      method: "x.ai/session_notification",
      params: {
        sessionId: "parent",
        update: {
          sessionUpdate: "subagent_spawned",
          subagent_id: "sub-1",
          description: "Research",
          subagent_type: "explore",
        },
      },
    });
    const finish = translator.extensionNotification({
      type: "extension.notification",
      serverId: "grok-build",
      sessionKey: "session-1",
      turnId: "turn-1",
      method: "x.ai/session_notification",
      params: {
        sessionId: "parent",
        update: {
          sessionUpdate: "subagent_finished",
          subagent_id: "sub-1",
          status: "completed",
        },
      },
    });

    expect(spawn.find((part) => part.type === "tool-call")).toMatchObject({
      toolName: "task",
    });
    expect(spawn.some((part) => part.type === "tool-result")).toBe(false);
    expect(finish.find((part) => part.type === "tool-result")).toMatchObject({
      toolName: "task",
    });
  });

  it("projects Cursor questions onto the built-in question tool", () => {
    const translator = new AcpStreamTranslator("turn-1");
    const projection = translator.interaction({
      type: "interaction.extension",
      turnId: "turn-1",
      interactionId: "question-1",
      serverId: "cursor",
      sessionKey: "session-1",
      expiresAt: 123,
      method: "cursor/ask_question",
      params: {
        toolCallId: "cursor-tool-1",
        questions: [
          {
            id: "mode",
            prompt: "Which mode?",
            options: [
              { id: "plan", label: "Plan" },
              { id: "build", label: "Build" },
            ],
          },
        ],
      },
    });
    const call = projection?.parts.find((part) => part.type === "tool-call");

    expect(projection).toMatchObject({
      owner: "server",
      toolCallId: `opencode-acpx-question:${Buffer.from("question-1").toString("base64url")}`,
    });
    expect(call).toMatchObject({
      type: "tool-call",
      toolName: "question",
      providerExecuted: false,
    });
    if (call?.type !== "tool-call") throw new Error("missing question call");
    expect(call.input).toContain('"question":"Which mode?"');
  });

  it("projects ACP anyOf multi-select forms onto the built-in question tool", () => {
    const translator = new AcpStreamTranslator("turn-1");
    const projection = translator.interaction({
      type: "interaction.elicitation",
      interactionId: "form-1",
      serverId: "fixture",
      sessionKey: "session-1",
      turnId: "turn-1",
      expiresAt: Date.now() + 10_000,
      request: {
        mode: "form",
        message: "Choose targets",
        requestedSchema: {
          type: "object",
          properties: {
            targets: {
              type: "array",
              title: "Targets",
              items: {
                anyOf: [
                  { const: "web", title: "Web" },
                  { const: "api", title: "API" },
                ],
              },
            },
          },
        },
      },
    });

    expect(projection?.owner).toBe("server");
    const call = projection?.parts.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") throw new Error("missing question call");
    expect(call.input).toContain('"multiple":true');
    expect(call.input).toContain('"label":"Web"');
    expect(call.input).toContain('"label":"API"');
  });
});
