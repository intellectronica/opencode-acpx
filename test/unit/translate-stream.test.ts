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
      toolName: "acp_read",
      providerExecuted: true,
      dynamic: true,
    });
    expect(result).toMatchObject({
      toolCallId: "turn-1-tool-remote-1",
      result: { text: "hello" },
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
