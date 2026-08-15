import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type { AcpPermissionDecision } from "acpx/runtime";

import {
  INTERACTION_TOOL_NAME,
  PERMISSION_TOOL_NAME,
  QUESTION_TOOL_NAME,
} from "../constants.js";
import type {
  ElicitationInteraction,
  ExtensionInteraction,
  ExtensionResponseParams,
} from "../worker/messages.js";

export interface AcpxCallRouting {
  openCodeSessionId: string;
  requestId: string;
  generation: number;
  mode?: string;
  agent?: string;
}

export interface AcpxPrompt {
  text: string;
  attachments?: { mediaType: string; data: string }[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ACP provider option ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * OpenCode namespaces model options under the complete provider ID for custom
 * SDKs. Dots are significant and must not be treated as object traversal.
 */
export function readCallRouting(
  options: LanguageModelV3CallOptions,
  providerId: string,
): AcpxCallRouting {
  const routed = options.providerOptions?.[providerId];
  if (!isObject(routed)) {
    throw new Error(
      `Missing ACP routing options for the full provider ID ${JSON.stringify(providerId)}`,
    );
  }
  const generation = routed.generation ?? 0;
  if (!Number.isInteger(generation) || (generation as number) < 0) {
    throw new Error(
      "ACP provider option generation must be a non-negative integer",
    );
  }
  const mode = routed.mode;
  if (mode !== undefined && (typeof mode !== "string" || mode.length === 0)) {
    throw new Error("ACP provider option mode must be a non-empty string");
  }
  const agent = routed.agent;
  if (
    agent !== undefined &&
    (typeof agent !== "string" || agent.length === 0)
  ) {
    throw new Error("ACP provider option agent must be a non-empty string");
  }
  return {
    openCodeSessionId: requiredString(
      routed.openCodeSessionId,
      "openCodeSessionId",
    ),
    requestId: requiredString(routed.requestId, "requestId"),
    generation: generation as number,
    ...(mode === undefined ? {} : { mode }),
    ...(agent === undefined ? {} : { agent }),
  };
}

export function readLatestUserPrompt(
  prompt: LanguageModelV3Prompt,
): AcpxPrompt {
  const user = prompt.findLast((message) => message.role === "user");
  if (user === undefined) {
    throw new Error("ACP turns require a user message");
  }
  const text: string[] = [];
  const attachments: { mediaType: string; data: string }[] = [];
  for (const part of user.content) {
    if (part.type === "text") {
      text.push(part.text);
      continue;
    }
    if (part.data instanceof URL) {
      throw new Error(
        "ACP prompt URL attachments must be downloaded before provider invocation",
      );
    }
    attachments.push({
      mediaType: part.mediaType,
      data:
        typeof part.data === "string"
          ? part.data
          : Buffer.from(part.data).toString("base64"),
    });
  }
  return {
    text: text.join("\n"),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

const permissionOutcomes = new Set<AcpPermissionDecision["outcome"]>([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
  "cancel",
]);

function decodeOutput(value: unknown): unknown {
  if (!isObject(value) || typeof value.type !== "string") return value;
  if (value.type === "json") return value.value;
  if (value.type === "text") {
    try {
      return JSON.parse(String(value.value));
    } catch {
      return value.value;
    }
  }
  return { decision: { outcome: "cancel" } };
}

export function readPermissionDecision(
  prompt: LanguageModelV3Prompt,
  toolCallId: string,
  interactionId: string,
): AcpPermissionDecision | undefined {
  for (const message of [...prompt].reverse()) {
    if (message.role !== "tool" && message.role !== "assistant") continue;
    for (const part of [...message.content].reverse()) {
      if (part.type !== "tool-result" || part.toolName !== PERMISSION_TOOL_NAME)
        continue;
      if (part.toolCallId !== toolCallId) continue;
      const decoded = decodeOutput(part.output);
      if (!isObject(decoded)) return { outcome: "cancel" };
      if (
        decoded.interactionId !== undefined &&
        decoded.interactionId !== interactionId
      ) {
        return { outcome: "cancel" };
      }
      const candidate = isObject(decoded.decision) ? decoded.decision : decoded;
      const outcome = candidate.outcome;
      if (
        typeof outcome !== "string" ||
        !permissionOutcomes.has(outcome as AcpPermissionDecision["outcome"])
      ) {
        return { outcome: "cancel" };
      }
      return { outcome } as AcpPermissionDecision;
    }
  }
  return undefined;
}

export type GenericInteractionResponse =
  | { kind: "elicitation"; interactionId: string; response: unknown }
  | { kind: "extension"; params: ExtensionResponseParams };

function findToolOutput(
  prompt: LanguageModelV3Prompt,
  toolCallId: string,
  toolName: string,
): unknown {
  for (const message of [...prompt].reverse()) {
    if (message.role !== "tool" && message.role !== "assistant") continue;
    for (const part of [...message.content].reverse()) {
      if (
        part.type === "tool-result" &&
        part.toolCallId === toolCallId &&
        part.toolName === toolName
      ) {
        return decodeOutput(part.output);
      }
    }
  }
  return undefined;
}

export function hasQuestionResult(
  prompt: LanguageModelV3Prompt,
  toolCallId: string,
): boolean {
  return findToolOutput(prompt, toolCallId, QUESTION_TOOL_NAME) !== undefined;
}

function extensionCancellation(method: string): ExtensionResponseParams {
  if (method === "cursor/ask_question" || method === "cursor/create_plan") {
    return { interactionId: "", result: { outcome: { outcome: "cancelled" } } };
  }
  return {
    interactionId: "",
    error: {
      code: "ACP_INTERACTION_UNAVAILABLE",
      message: "No compatible OpenCode interaction renderer is available",
    },
  };
}

export function readGenericInteractionResponse(
  prompt: LanguageModelV3Prompt,
  toolCallId: string,
  event: ElicitationInteraction | ExtensionInteraction,
): GenericInteractionResponse | undefined {
  const decoded = findToolOutput(prompt, toolCallId, INTERACTION_TOOL_NAME);
  if (decoded === undefined) return undefined;
  if (!isObject(decoded)) {
    return event.type === "interaction.elicitation"
      ? {
          kind: "elicitation",
          interactionId: event.interactionId,
          response: { action: "cancel" },
        }
      : {
          kind: "extension",
          params: {
            ...extensionCancellation(event.method),
            interactionId: event.interactionId,
          },
        };
  }
  const expectedMethod =
    event.type === "interaction.elicitation"
      ? "elicitation/create"
      : event.method;
  if (
    decoded.interactionId !== event.interactionId ||
    decoded.method !== expectedMethod
  ) {
    return event.type === "interaction.elicitation"
      ? {
          kind: "elicitation",
          interactionId: event.interactionId,
          response: { action: "cancel" },
        }
      : {
          kind: "extension",
          params: {
            ...extensionCancellation(event.method),
            interactionId: event.interactionId,
          },
        };
  }
  if (event.type === "interaction.elicitation") {
    return {
      kind: "elicitation",
      interactionId: event.interactionId,
      response: decoded.response ?? { action: "cancel" },
    };
  }
  const error = decoded.error;
  if (
    isObject(error) &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return {
      kind: "extension",
      params: {
        interactionId: event.interactionId,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }
  if ("result" in decoded) {
    return {
      kind: "extension",
      params: { interactionId: event.interactionId, result: decoded.result },
    };
  }
  return {
    kind: "extension",
    params: {
      ...extensionCancellation(event.method),
      interactionId: event.interactionId,
    },
  };
}
