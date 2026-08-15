/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/require-await */
import type { ToolContext } from "@opencode-ai/plugin";
import { describe, expect, it, vi } from "vitest";

import { INTERACTION_TOOL_NAME } from "../../src/constants.js";
import { GenericInteractionBroker } from "../../src/interactions/generic.js";

const input = {
  interactionId: "interaction-1",
  serverId: "cursor",
  sessionKey: "session-key-1",
  expiresAt: 20_000,
  method: "cursor/create_plan",
  request: { name: "Upgrade dependencies" },
};

function context(ask: ToolContext["ask"]): ToolContext {
  return {
    sessionID: "oc-session-1",
    messageID: "message-1",
    agent: "build",
    directory: "/repo",
    worktree: "/repo",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask,
  };
}

function prepare() {
  const broker = new GenericInteractionBroker(() => 10_000);
  broker.bindSession("session-key-1", "oc-session-1");
  broker.observeWorkerEvent({
    type: "interaction.extension",
    interactionId: "interaction-1",
    serverId: "cursor",
    sessionKey: "session-key-1",
    expiresAt: 20_000,
    method: "cursor/create_plan",
    params: { name: "Upgrade dependencies" },
  });
  broker.beforeToolExecute(
    INTERACTION_TOOL_NAME,
    {
      tool: INTERACTION_TOOL_NAME,
      sessionID: "oc-session-1",
      callID: "call-1",
    },
    input,
  );
  return broker;
}

function outputOf(
  result: Awaited<ReturnType<GenericInteractionBroker["execute"]>>,
) {
  if (typeof result === "string")
    throw new Error("Expected structured tool result");
  return JSON.parse(result.output) as Record<string, unknown>;
}

function questionCallId(interactionId: string): string {
  return `opencode-acpx-question:${Buffer.from(interactionId, "utf8").toString("base64url")}`;
}

describe("GenericInteractionBroker", () => {
  it("correlates and approves a Cursor plan through OpenCode permissions", async () => {
    const broker = prepare();
    const result = await broker.execute(
      input,
      context(async () => {}),
    );
    expect(outputOf(result)).toEqual({
      interactionId: "interaction-1",
      method: "cursor/create_plan",
      result: { outcome: { outcome: "accepted" } },
    });
  });

  it("returns a correlated rejection", async () => {
    const broker = prepare();
    const result = await broker.execute(
      input,
      context(async () => {
        throw new Error("rejected");
      }),
    );
    expect(outputOf(result)).toMatchObject({
      interactionId: "interaction-1",
      result: { outcome: { outcome: "rejected" } },
    });
  });

  it("fails closed for a fabricated elicitation", async () => {
    const broker = prepare();
    const result = await broker.execute(
      { ...input, interactionId: "fabricated", method: "elicitation/create" },
      context(async () => {}),
    );
    expect(outputOf(result)).toMatchObject({
      interactionId: "fabricated",
      response: { action: "cancel" },
    });
  });

  it("returns exact standard form answers through the worker", async () => {
    const respondElicitation = vi.fn(async () => ({ ok: true }));
    const broker = new GenericInteractionBroker({
      now: () => 10_000,
      respondElicitation,
    });
    broker.bindSession("session-key-1", "oc-session-1");
    broker.observeWorkerEvent({
      type: "interaction.elicitation",
      interactionId: "form-1",
      serverId: "claude",
      sessionKey: "session-key-1",
      expiresAt: 20_000,
      request: {
        mode: "form",
        message: "Configure release",
        requestedSchema: {
          required: ["name", "channel", "retries", "confirmed", "targets"],
          properties: {
            name: { type: "string", title: "Name" },
            channel: {
              type: "string",
              oneOf: [
                { const: "stable", title: "Stable" },
                { const: "preview", title: "Preview" },
              ],
            },
            retries: { type: "integer", minimum: 0, maximum: 5 },
            confirmed: { type: "boolean" },
            targets: {
              type: "array",
              items: {
                type: "string",
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
    const callID = questionCallId("form-1");
    broker.beforeQuestionExecute({
      tool: "question",
      sessionID: "oc-session-1",
      callID,
    });

    await broker.afterQuestionExecute(
      { tool: "question", sessionID: "oc-session-1", callID },
      {
        answers: [["v2"], ["Stable"], ["3"], ["Yes"], ["Web", "API"]],
      },
    );

    expect(respondElicitation).toHaveBeenCalledOnce();
    expect(respondElicitation).toHaveBeenCalledWith("form-1", {
      action: "accept",
      content: {
        name: "v2",
        channel: "stable",
        retries: 3,
        confirmed: true,
        targets: ["web", "api"],
      },
    });
  });

  it("maps Cursor labels to exact option IDs", async () => {
    const respondExtension = vi.fn(async () => ({ ok: true }));
    const broker = new GenericInteractionBroker({
      now: () => 10_000,
      respondExtension,
    });
    broker.bindSession("session-key-1", "oc-session-1");
    broker.observeWorkerEvent({
      type: "interaction.extension",
      interactionId: "cursor-question-1",
      serverId: "cursor",
      sessionKey: "session-key-1",
      expiresAt: 20_000,
      method: "cursor/ask_question",
      params: {
        toolCallId: "cursor-tool-1",
        questions: [
          {
            id: "ship",
            prompt: "Ship now?",
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
          },
          {
            id: "targets",
            prompt: "Where?",
            allowMultiple: true,
            options: [
              { id: "web", label: "Web" },
              { id: "api", label: "API" },
            ],
          },
        ],
      },
    });
    const callID = questionCallId("cursor-question-1");
    broker.beforeQuestionExecute({
      tool: "question",
      sessionID: "oc-session-1",
      callID,
    });

    await broker.afterQuestionExecute(
      { tool: "question", sessionID: "oc-session-1", callID },
      { answers: [["Yes"], ["Web", "api"]] },
    );

    expect(respondExtension).toHaveBeenCalledOnce();
    expect(respondExtension).toHaveBeenCalledWith({
      interactionId: "cursor-question-1",
      result: {
        outcome: {
          outcome: "answered",
          answers: [
            { questionId: "ship", selectedOptionIds: ["yes"] },
            { questionId: "targets", selectedOptionIds: ["web", "api"] },
          ],
        },
      },
    });
  });

  it("correlates a question rejection and cancels exactly once", async () => {
    const respondExtension = vi.fn(async () => ({ ok: true }));
    const broker = new GenericInteractionBroker({
      now: () => 10_000,
      respondExtension,
    });
    broker.bindSession("session-key-1", "oc-session-1");
    broker.observeWorkerEvent({
      type: "interaction.extension",
      interactionId: "cursor-question-2",
      serverId: "cursor",
      sessionKey: "session-key-1",
      expiresAt: 20_000,
      method: "cursor/ask_question",
      params: {
        questions: [
          {
            id: "ship",
            prompt: "Ship now?",
            options: [{ id: "yes", label: "Yes" }],
          },
        ],
      },
    });
    const callID = questionCallId("cursor-question-2");
    broker.beforeQuestionExecute({
      tool: "question",
      sessionID: "oc-session-1",
      callID,
    });
    await broker.ingestOpenCodeEvent({
      type: "question.asked",
      properties: {
        id: "question-request-1",
        sessionID: "oc-session-1",
        questions: [],
        tool: { messageID: "message-1", callID },
      },
    });
    await broker.ingestOpenCodeEvent({
      type: "question.rejected",
      properties: {
        sessionID: "oc-session-1",
        requestID: "question-request-1",
      },
    });
    await broker.ingestOpenCodeEvent({
      type: "question.rejected",
      properties: {
        sessionID: "oc-session-1",
        requestID: "question-request-1",
      },
    });

    expect(respondExtension).toHaveBeenCalledOnce();
    expect(respondExtension).toHaveBeenCalledWith({
      interactionId: "cursor-question-2",
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  it("ignores fabricated question call IDs and answer metadata", async () => {
    const respondElicitation = vi.fn(async () => ({ ok: true }));
    const broker = new GenericInteractionBroker({
      now: () => 10_000,
      respondElicitation,
    });
    broker.bindSession("session-key-1", "oc-session-1");
    broker.observeWorkerEvent({
      type: "interaction.elicitation",
      interactionId: "form-2",
      serverId: "claude",
      sessionKey: "session-key-1",
      expiresAt: 20_000,
      request: {
        mode: "form",
        requestedSchema: {
          properties: { value: { type: "string" } },
        },
      },
    });
    const fabricated = questionCallId("someone-elses-interaction");
    broker.beforeQuestionExecute({
      tool: "question",
      sessionID: "oc-session-1",
      callID: fabricated,
    });
    await broker.afterQuestionExecute(
      { tool: "question", sessionID: "oc-session-1", callID: fabricated },
      { answers: [["secret"]] },
    );

    expect(respondElicitation).not.toHaveBeenCalled();
  });
});
