import type {
  JSONValue,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type {
  AcpRuntimeEvent,
  AcpRuntimeTurnResult,
  AcpRuntimeUsageBreakdown,
} from "acpx/runtime";

import {
  INTERACTION_TOOL_NAME,
  PERMISSION_TOOL_NAME,
  QUESTION_TOOL_NAME,
} from "../constants.js";
import type {
  ElicitationInteraction,
  ExtensionInteraction,
  PermissionInteraction,
} from "../worker/messages.js";

interface OpenBlock {
  kind: "text" | "reasoning";
  id: string;
}
interface ToolState {
  name: string;
  callEmitted: boolean;
  finalResultEmitted: boolean;
}

interface QuestionInput {
  questions: {
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiple?: boolean;
  }[];
}

export interface InteractionProjection {
  parts: LanguageModelV3StreamPart[];
  toolCallId: string;
  owner: "provider" | "server";
}

const terminalToolStatuses = new Set([
  "completed",
  "failed",
  "error",
  "rejected",
  "cancelled",
]);

function jsonValue(value: unknown): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    const result: Record<string, JSONValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        item !== undefined &&
        typeof item !== "function" &&
        typeof item !== "symbol"
      ) {
        result[key] = jsonValue(item);
      }
    }
    return result;
  }
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "symbol";
  return "unsupported";
}

function safeStringify(value: unknown): string {
  return JSON.stringify(jsonValue(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortHeader(value: string): string {
  return value.trim().slice(0, 30) || "ACP question";
}

function labelledOptions(
  value: unknown,
): { label: string; description: string }[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: { label: string; description: string }[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      result.push({ label: item, description: item });
      continue;
    }
    if (!isRecord(item)) return undefined;
    const label = typeof item.label === "string" ? item.label : item.title;
    if (typeof label !== "string" || label.length === 0) return undefined;
    result.push({ label, description: label });
  }
  return result;
}

function cursorQuestions(params: unknown): QuestionInput | undefined {
  if (
    !isRecord(params) ||
    !Array.isArray(params.questions) ||
    params.questions.length === 0
  )
    return undefined;
  const questions: QuestionInput["questions"] = [];
  for (const value of params.questions) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.prompt !== "string"
    )
      return undefined;
    const options = labelledOptions(value.options);
    if (options === undefined) return undefined;
    questions.push({
      question: value.prompt,
      header: shortHeader(value.id),
      options,
      ...(value.allowMultiple === true ? { multiple: true } : {}),
    });
  }
  return { questions };
}

function formQuestions(request: unknown): QuestionInput | undefined {
  if (
    !isRecord(request) ||
    request.mode !== "form" ||
    !isRecord(request.requestedSchema)
  )
    return undefined;
  const properties = request.requestedSchema.properties;
  if (!isRecord(properties) || Object.keys(properties).length === 0)
    return undefined;
  const message =
    typeof request.message === "string"
      ? request.message
      : "Provide the requested value";
  const questions: QuestionInput["questions"] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (!isRecord(value) || typeof value.type !== "string") return undefined;
    const title = typeof value.title === "string" ? value.title : key;
    const question =
      typeof value.description === "string"
        ? value.description
        : `${message}: ${title}`;
    if (value.type === "boolean") {
      questions.push({
        question,
        header: shortHeader(title),
        options: [
          { label: "Yes", description: "Set this value to true" },
          { label: "No", description: "Set this value to false" },
        ],
      });
      continue;
    }
    if (
      value.type === "string" ||
      value.type === "number" ||
      value.type === "integer"
    ) {
      const options =
        labelledOptions(value.enum) ?? labelledOptions(value.oneOf) ?? [];
      questions.push({ question, header: shortHeader(title), options });
      continue;
    }
    if (value.type === "array" && isRecord(value.items)) {
      const options =
        labelledOptions(value.items.enum) ??
        labelledOptions(value.items.oneOf) ??
        labelledOptions(value.items.anyOf);
      if (options === undefined) return undefined;
      questions.push({
        question,
        header: shortHeader(title),
        options,
        multiple: true,
      });
      continue;
    }
    return undefined;
  }
  return { questions };
}

function questionToolCallId(interactionId: string): string {
  return `opencode-acpx-question:${Buffer.from(interactionId, "utf8").toString("base64url")}`;
}

function toolName(
  event: Extract<AcpRuntimeEvent, { type: "tool_call" }>,
): string {
  return `acp_${event.kind ?? "tool"}`;
}

function finishReason(
  result: AcpRuntimeTurnResult,
): LanguageModelV3FinishReason {
  if (result.status === "failed")
    return { unified: "error", raw: result.error.code ?? "failed" };
  const raw = result.stopReason;
  if (raw === "max_tokens" || raw === "length" || raw === "max_output_tokens") {
    return { unified: "length", raw };
  }
  if (result.status === "cancelled")
    return { unified: "other", raw: raw ?? "cancelled" };
  return { unified: "stop", raw };
}

export function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

function usageFromBreakdown(
  value: AcpRuntimeUsageBreakdown | undefined,
): LanguageModelV3Usage {
  if (value === undefined) return emptyUsage();
  const cacheRead = value.cachedReadTokens;
  const cacheWrite = value.cachedWriteTokens;
  const noCache =
    value.inputTokens === undefined
      ? undefined
      : Math.max(0, value.inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0));
  const text =
    value.outputTokens === undefined
      ? undefined
      : Math.max(0, value.outputTokens - (value.thoughtTokens ?? 0));
  return {
    inputTokens: { total: value.inputTokens, noCache, cacheRead, cacheWrite },
    outputTokens: {
      total: value.outputTokens,
      text,
      reasoning: value.thoughtTokens,
    },
    raw: jsonValue(value) as Record<string, JSONValue>,
  };
}

export class AcpStreamTranslator {
  readonly #turnId: string;
  readonly #tools = new Map<string, ToolState>();
  #open: OpenBlock | undefined;
  #blockSequence = 0;
  #usage: AcpRuntimeUsageBreakdown | undefined;

  constructor(turnId: string, usage?: AcpRuntimeUsageBreakdown) {
    this.#turnId = turnId;
    this.#usage = usage;
  }

  get usage(): AcpRuntimeUsageBreakdown | undefined {
    return this.#usage;
  }

  event(event: AcpRuntimeEvent, index: number): LanguageModelV3StreamPart[] {
    if (event.type === "status") {
      if (event.breakdown !== undefined) this.#usage = event.breakdown;
      return [];
    }
    if (event.type === "text_delta") return this.#text(event);
    if (event.type === "tool_call") return this.#tool(event, index);
    if (event.type === "error") {
      return [
        ...this.#closeBlock(),
        { type: "error", error: new Error(event.message) },
      ];
    }
    return [];
  }

  permission(event: PermissionInteraction): LanguageModelV3StreamPart[] {
    const parts = this.#closeBlock();
    const id = permissionToolCallId(event.interactionId);
    const input = safeStringify({
      interactionId: event.interactionId,
      serverId: event.serverId,
      sessionKey: event.sessionKey,
      expiresAt: event.expiresAt,
      request: event.request,
      ...(event.inferredKind === undefined
        ? {}
        : { inferredKind: event.inferredKind }),
    });
    parts.push(
      {
        type: "tool-input-start",
        id,
        toolName: PERMISSION_TOOL_NAME,
        dynamic: true,
      },
      { type: "tool-input-delta", id, delta: input },
      { type: "tool-input-end", id },
      {
        type: "tool-call",
        toolCallId: id,
        toolName: PERMISSION_TOOL_NAME,
        input,
        providerExecuted: false,
        dynamic: true,
      },
      {
        type: "finish",
        usage: usageFromBreakdown(this.#usage),
        finishReason: { unified: "tool-calls", raw: "permission" },
      },
    );
    return parts;
  }

  interaction(
    event: ElicitationInteraction | ExtensionInteraction,
  ): InteractionProjection | undefined {
    const questionInput =
      event.type === "interaction.elicitation"
        ? formQuestions(event.request)
        : event.method === "cursor/ask_question"
          ? cursorQuestions(event.params)
          : undefined;
    if (questionInput !== undefined) {
      const toolCallId = questionToolCallId(event.interactionId);
      return {
        toolCallId,
        owner: "server",
        parts: this.#ordinaryToolCall(
          toolCallId,
          QUESTION_TOOL_NAME,
          questionInput,
        ),
      };
    }
    if (event.sessionKey === undefined) return undefined;
    const method =
      event.type === "interaction.elicitation"
        ? "elicitation/create"
        : event.method;
    const request =
      event.type === "interaction.elicitation" ? event.request : event.params;
    const toolCallId = `${this.#turnId}-interaction-${Buffer.from(event.interactionId, "utf8").toString("base64url")}`;
    return {
      toolCallId,
      owner: "provider",
      parts: this.#ordinaryToolCall(toolCallId, INTERACTION_TOOL_NAME, {
        interactionId: event.interactionId,
        serverId: event.serverId,
        sessionKey: event.sessionKey,
        expiresAt: event.expiresAt,
        method,
        request,
      }),
    };
  }

  terminal(result: AcpRuntimeTurnResult): LanguageModelV3StreamPart[] {
    const parts = this.#closeBlock();
    if (result.status === "failed")
      parts.push({ type: "error", error: new Error(result.error.message) });
    parts.push({
      type: "finish",
      usage: usageFromBreakdown(this.#usage),
      finishReason: finishReason(result),
    });
    return parts;
  }

  #text(
    event: Extract<AcpRuntimeEvent, { type: "text_delta" }>,
  ): LanguageModelV3StreamPart[] {
    const kind = event.stream === "thought" ? "reasoning" : "text";
    const parts: LanguageModelV3StreamPart[] = [];
    if (this.#open?.kind !== kind) {
      parts.push(...this.#closeBlock());
      const id = `${this.#turnId}-${kind}-${String(this.#blockSequence++)}`;
      this.#open = { kind, id };
      parts.push(
        kind === "text"
          ? { type: "text-start", id }
          : { type: "reasoning-start", id },
      );
    }
    const id = this.#open.id;
    parts.push(
      kind === "text"
        ? { type: "text-delta", id, delta: event.text }
        : { type: "reasoning-delta", id, delta: event.text },
    );
    return parts;
  }

  #tool(
    event: Extract<AcpRuntimeEvent, { type: "tool_call" }>,
    index: number,
  ): LanguageModelV3StreamPart[] {
    const parts = this.#closeBlock();
    const id = `${this.#turnId}-tool-${event.toolCallId ?? String(index)}`;
    const state = this.#tools.get(id) ?? {
      name: toolName(event),
      callEmitted: false,
      finalResultEmitted: false,
    };
    this.#tools.set(id, state);
    if (!state.callEmitted) {
      const input = safeStringify(event.rawInput ?? { summary: event.text });
      parts.push(
        {
          type: "tool-input-start",
          id,
          toolName: state.name,
          providerExecuted: true,
          dynamic: true,
          ...(event.title === undefined ? {} : { title: event.title }),
        },
        { type: "tool-input-delta", id, delta: input },
        { type: "tool-input-end", id },
        {
          type: "tool-call",
          toolCallId: id,
          toolName: state.name,
          input,
          providerExecuted: true,
          dynamic: true,
        },
      );
      state.callEmitted = true;
    }
    const terminal =
      event.status === undefined ||
      terminalToolStatuses.has(event.status.toLowerCase());
    if (!terminal || state.finalResultEmitted) return parts;
    state.finalResultEmitted = true;
    const output = event.rawOutput ?? event.content ?? event.text;
    const translatedOutput = jsonValue(output);
    const lowerStatus = event.status?.toLowerCase();
    parts.push({
      type: "tool-result",
      toolCallId: id,
      toolName: state.name,
      result: translatedOutput ?? { value: null },
      dynamic: true,
      ...(lowerStatus === "failed" ||
      lowerStatus === "error" ||
      lowerStatus === "rejected"
        ? { isError: true }
        : {}),
    });
    return parts;
  }

  #closeBlock(): LanguageModelV3StreamPart[] {
    const open = this.#open;
    if (open === undefined) return [];
    this.#open = undefined;
    return [
      open.kind === "text"
        ? { type: "text-end", id: open.id }
        : { type: "reasoning-end", id: open.id },
    ];
  }

  #ordinaryToolCall(
    id: string,
    toolName: string,
    value: unknown,
  ): LanguageModelV3StreamPart[] {
    const parts = this.#closeBlock();
    const input = safeStringify(value);
    parts.push(
      { type: "tool-input-start", id, toolName, dynamic: true },
      { type: "tool-input-delta", id, delta: input },
      { type: "tool-input-end", id },
      {
        type: "tool-call",
        toolCallId: id,
        toolName,
        input,
        providerExecuted: false,
        dynamic: true,
      },
      {
        type: "finish",
        usage: usageFromBreakdown(this.#usage),
        finishReason: { unified: "tool-calls", raw: "interaction" },
      },
    );
    return parts;
  }
}

export function permissionToolCallId(interactionId: string): string {
  return `opencode-acpx-permission-${interactionId}`;
}
