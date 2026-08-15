import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { PERMISSION_TOOL_NAME } from "../../src/constants.js";
import {
  readCallRouting,
  readLatestUserPrompt,
  readPermissionDecision,
} from "../../src/translate/input.js";

function call(
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...overrides,
  };
}

describe("ACP input translation", () => {
  it("routes with the complete dotted provider ID", () => {
    const options = call({
      providerOptions: {
        acp: { openCodeSessionId: "wrong", requestId: "wrong" },
        "acp.cursor.work": {
          openCodeSessionId: "session-1",
          requestId: "message-1",
          generation: 2,
          mode: "plan",
        },
      },
    });

    expect(readCallRouting(options, "acp.cursor.work")).toEqual({
      openCodeSessionId: "session-1",
      requestId: "message-1",
      generation: 2,
      mode: "plan",
    });
  });

  it("fails rather than falling back to a dotted prefix", () => {
    expect(() =>
      readCallRouting(
        call({
          providerOptions: {
            acp: { openCodeSessionId: "session", requestId: "message" },
          },
        }),
        "acp.cursor",
      ),
    ).toThrow(/full provider ID/);
  });

  it("uses only the latest user message and converts binary attachments", () => {
    const prompt = readLatestUserPrompt([
      { role: "user", content: [{ type: "text", text: "old" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "new" },
          {
            type: "file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
          },
        ],
      },
    ]);

    expect(prompt).toEqual({
      text: "new",
      attachments: [{ mediaType: "image/png", data: "AQID" }],
    });
  });

  it("reads a correlated permission decision and cancels malformed output", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "permission-1",
            toolName: PERMISSION_TOOL_NAME,
            output: {
              type: "text",
              value: JSON.stringify({
                interactionId: "interaction-1",
                decision: { outcome: "allow_once" },
              }),
            },
          },
        ],
      },
    ];
    expect(
      readPermissionDecision(prompt, "permission-1", "interaction-1"),
    ).toEqual({
      outcome: "allow_once",
    });

    const malformed = structuredClone(prompt);
    const message = malformed[0];
    if (message?.role !== "tool") throw new Error("invalid fixture");
    const result = message.content[0];
    if (result?.type !== "tool-result") throw new Error("invalid fixture");
    result.output = {
      type: "json",
      value: { decision: { outcome: "surprise" } },
    };
    expect(
      readPermissionDecision(malformed, "permission-1", "interaction-1"),
    ).toEqual({
      outcome: "cancel",
    });
  });
});
