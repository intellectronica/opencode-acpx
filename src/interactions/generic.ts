import type { ToolContext, ToolResult } from "@opencode-ai/plugin";

import type { ExtensionResponseParams } from "../worker/messages.js";

export interface GenericInteractionToolInput {
  interactionId: string;
  serverId: string;
  sessionKey: string;
  expiresAt: number;
  method: string;
  request?: unknown;
}

interface GenericInteractionEvent {
  type: "interaction.elicitation" | "interaction.extension";
  interactionId: string;
  serverId: string;
  sessionKey?: string;
  expiresAt: number;
  request?: unknown;
  method?: string;
  params?: unknown;
}

interface PendingGenericInteraction {
  event: GenericInteractionEvent;
  openCodeSessionId?: string;
  reservedCallId?: string;
  questionCallId?: string;
  questionRequestId?: string;
}

interface ToolExecutionInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface BrokerOptions {
  now?: () => number;
  respondElicitation?: (
    interactionId: string,
    response: unknown,
  ) => Promise<unknown>;
  respondExtension?: (params: ExtensionResponseParams) => Promise<unknown>;
}

interface QuestionAskedEvent {
  type: "question.asked";
  properties: {
    id: string;
    sessionID: string;
    tool: { callID: string };
  };
}

interface QuestionRejectedEvent {
  type: "question.rejected";
  properties: {
    sessionID: string;
    requestID: string;
  };
}

interface FormRequest {
  mode: "form";
  requestedSchema: {
    properties: Record<string, Record<string, unknown>>;
    required: Set<string>;
  };
}

interface CursorQuestion {
  id: string;
  allowMultiple: boolean;
  options: { id: string; label: string }[];
}

const QUESTION_TOOL_NAME = "question";
const QUESTION_CALL_PREFIX = "opencode-acpx-question:";

export class GenericInteractionBroker {
  readonly #pending = new Map<string, PendingGenericInteraction>();
  readonly #sessionByKey = new Map<string, string>();
  readonly #interactionByQuestionRequest = new Map<string, string>();
  readonly #now: () => number;
  readonly #respondElicitation: BrokerOptions["respondElicitation"];
  readonly #respondExtension: BrokerOptions["respondExtension"];

  constructor(options: BrokerOptions | (() => number) = {}) {
    const normalised =
      typeof options === "function" ? { now: options } : options;
    this.#now = normalised.now ?? Date.now;
    this.#respondElicitation = normalised.respondElicitation;
    this.#respondExtension = normalised.respondExtension;
  }

  bindSession(sessionKey: string, openCodeSessionId: string): void {
    this.#sessionByKey.set(sessionKey, openCodeSessionId);
    for (const pending of this.#pending.values()) {
      if (pending.event.sessionKey === sessionKey)
        pending.openCodeSessionId = openCodeSessionId;
    }
  }

  observeWorkerEvent(value: unknown): void {
    const event = parseGenericInteractionEvent(value);
    if (event === undefined) return;
    const openCodeSessionId =
      event.sessionKey === undefined
        ? undefined
        : this.#sessionByKey.get(event.sessionKey);
    this.#pending.set(event.interactionId, {
      event,
      ...(openCodeSessionId === undefined ? {} : { openCodeSessionId }),
    });
  }

  beforeToolExecute(
    toolName: string,
    input: ToolExecutionInput,
    args: unknown,
  ): void {
    if (input.tool !== toolName || !isGenericInteractionToolInput(args)) return;
    const pending = this.#pending.get(args.interactionId);
    if (!this.#matchesReserved(pending, args, input.sessionID)) return;
    pending.reservedCallId = input.callID;
  }

  beforeQuestionExecute(input: ToolExecutionInput): void {
    if (input.tool !== QUESTION_TOOL_NAME) return;
    const interactionId = interactionIdFromQuestionCall(input.callID);
    if (interactionId === undefined) return;
    const pending = this.#pending.get(interactionId);
    if (
      pending === undefined ||
      pending.openCodeSessionId !== input.sessionID ||
      this.#now() >= pending.event.expiresAt ||
      !isQuestionProjectable(pending.event)
    ) {
      return;
    }
    pending.questionCallId = input.callID;
  }

  async afterQuestionExecute(
    input: ToolExecutionInput,
    metadata: unknown,
  ): Promise<void> {
    if (input.tool !== QUESTION_TOOL_NAME) return;
    const interactionId = interactionIdFromQuestionCall(input.callID);
    if (interactionId === undefined) return;
    const pending = this.#pending.get(interactionId);
    if (
      pending === undefined ||
      pending.questionCallId !== input.callID ||
      pending.openCodeSessionId !== input.sessionID
    ) {
      return;
    }
    this.#removePending(interactionId, pending);
    const answers = questionAnswers(metadata);
    if (this.#now() >= pending.event.expiresAt || answers === undefined) {
      await this.#respondCancellation(pending.event);
      return;
    }
    if (pending.event.type === "interaction.elicitation") {
      const response = formResponse(pending.event.request, answers);
      await this.#respondElicitation?.(interactionId, response);
      return;
    }
    const response = cursorResponse(pending.event.params, answers);
    await this.#respondExtension?.({ interactionId, result: response });
  }

  async ingestOpenCodeEvent(value: unknown): Promise<void> {
    if (isQuestionAskedEvent(value)) {
      const interactionId = interactionIdFromQuestionCall(
        value.properties.tool.callID,
      );
      if (interactionId === undefined) return;
      const pending = this.#pending.get(interactionId);
      if (
        pending === undefined ||
        pending.questionCallId !== value.properties.tool.callID ||
        pending.openCodeSessionId !== value.properties.sessionID
      ) {
        return;
      }
      pending.questionRequestId = value.properties.id;
      this.#interactionByQuestionRequest.set(
        questionRequestKey(value.properties.sessionID, value.properties.id),
        interactionId,
      );
      return;
    }
    if (!isQuestionRejectedEvent(value)) return;
    const key = questionRequestKey(
      value.properties.sessionID,
      value.properties.requestID,
    );
    const interactionId = this.#interactionByQuestionRequest.get(key);
    if (interactionId === undefined) return;
    const pending = this.#pending.get(interactionId);
    if (
      pending === undefined ||
      pending.questionRequestId !== value.properties.requestID ||
      pending.openCodeSessionId !== value.properties.sessionID
    ) {
      this.#interactionByQuestionRequest.delete(key);
      return;
    }
    this.#removePending(interactionId, pending);
    await this.#respondCancellation(pending.event);
  }

  deleteSession(openCodeSessionId: string): void {
    for (const [key, sessionId] of this.#sessionByKey) {
      if (sessionId === openCodeSessionId) this.#sessionByKey.delete(key);
    }
    for (const [interactionId, pending] of this.#pending) {
      if (pending.openCodeSessionId === openCodeSessionId)
        this.#removePending(interactionId, pending);
    }
  }

  async execute(
    input: GenericInteractionToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const pending = this.#pending.get(input.interactionId);
    if (
      !this.#matchesReserved(pending, input, context.sessionID) ||
      pending.reservedCallId === undefined ||
      this.#now() >= pending.event.expiresAt
    ) {
      return genericResult(
        input,
        cancellationFor(input.method),
        "invalid or expired request",
      );
    }
    this.#removePending(input.interactionId, pending);
    if (input.method === "cursor/create_plan")
      return this.#approvePlan(input, pending, context);
    return genericResult(
      input,
      cancellationFor(input.method),
      "interactive renderer unavailable",
    );
  }

  async #approvePlan(
    input: GenericInteractionToolInput,
    pending: PendingGenericInteraction,
    context: ToolContext,
  ): Promise<ToolResult> {
    const title = planTitle(pending.event.params ?? input.request);
    context.metadata({
      title,
      metadata: { acpServer: input.serverId, acpMethod: input.method },
    });
    try {
      await context.ask({
        permission: `acp.${input.serverId}.plan`,
        patterns: [title],
        always: [],
        metadata: { title, acpServer: input.serverId, acpMethod: input.method },
      });
      return genericResult(input, {
        result: { outcome: { outcome: "accepted" } },
      });
    } catch {
      return genericResult(
        input,
        context.abort.aborted
          ? { result: { outcome: { outcome: "cancelled" } } }
          : { result: { outcome: { outcome: "rejected" } } },
      );
    }
  }

  async #respondCancellation(event: GenericInteractionEvent): Promise<void> {
    if (event.type === "interaction.elicitation") {
      await this.#respondElicitation?.(event.interactionId, {
        action: "cancel",
      });
      return;
    }
    await this.#respondExtension?.({
      interactionId: event.interactionId,
      result: { outcome: { outcome: "cancelled" } },
    });
  }

  #removePending(
    interactionId: string,
    pending: PendingGenericInteraction,
  ): void {
    this.#pending.delete(interactionId);
    if (pending.questionRequestId !== undefined) {
      this.#interactionByQuestionRequest.delete(
        questionRequestKey(
          pending.openCodeSessionId ?? "",
          pending.questionRequestId,
        ),
      );
    }
  }

  #matchesReserved(
    pending: PendingGenericInteraction | undefined,
    input: GenericInteractionToolInput,
    openCodeSessionId: string,
  ): pending is PendingGenericInteraction {
    return (
      pending !== undefined &&
      pending.event.serverId === input.serverId &&
      pending.event.sessionKey === input.sessionKey &&
      pending.event.expiresAt === input.expiresAt &&
      pending.openCodeSessionId === openCodeSessionId &&
      interactionMethod(pending.event) === input.method
    );
  }
}

export function isGenericInteractionToolInput(
  value: unknown,
): value is GenericInteractionToolInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.interactionId === "string" &&
    typeof value.serverId === "string" &&
    typeof value.sessionKey === "string" &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    typeof value.method === "string"
  );
}

function parseGenericInteractionEvent(
  value: unknown,
): GenericInteractionEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type !== "interaction.elicitation" &&
    value.type !== "interaction.extension"
  )
    return undefined;
  if (
    typeof value.interactionId !== "string" ||
    typeof value.serverId !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.sessionKey !== undefined && typeof value.sessionKey !== "string")
  ) {
    return undefined;
  }
  if (
    value.type === "interaction.extension" &&
    typeof value.method !== "string"
  )
    return undefined;
  return value as unknown as GenericInteractionEvent;
}

function interactionMethod(event: GenericInteractionEvent): string {
  return event.type === "interaction.elicitation"
    ? "elicitation/create"
    : (event.method ?? "");
}

function isQuestionProjectable(event: GenericInteractionEvent): boolean {
  return event.type === "interaction.elicitation"
    ? parseFormRequest(event.request) !== undefined
    : event.method === "cursor/ask_question" &&
        parseCursorQuestions(event.params) !== undefined;
}

function interactionIdFromQuestionCall(callId: string): string | undefined {
  if (!callId.startsWith(QUESTION_CALL_PREFIX)) return undefined;
  const encoded = callId.slice(QUESTION_CALL_PREFIX.length);
  if (encoded.length === 0 || encoded.length > 4096) return undefined;
  try {
    const interactionId = Buffer.from(encoded, "base64url").toString("utf8");
    if (
      interactionId.length === 0 ||
      Buffer.from(interactionId, "utf8").toString("base64url") !== encoded
    ) {
      return undefined;
    }
    return interactionId;
  } catch {
    return undefined;
  }
}

function questionAnswers(metadata: unknown): string[][] | undefined {
  if (!isRecord(metadata) || !Array.isArray(metadata.answers)) return undefined;
  const result: string[][] = [];
  const rawAnswers: unknown[] = metadata.answers;
  for (const answer of rawAnswers) {
    if (!Array.isArray(answer)) return undefined;
    const values: string[] = [];
    const rawValues: unknown[] = answer;
    for (const value of rawValues) {
      if (typeof value !== "string") return undefined;
      values.push(value);
    }
    result.push(values);
  }
  return result;
}

function formResponse(request: unknown, answers: string[][]): object {
  const form = parseFormRequest(request);
  if (form === undefined) return { action: "cancel" };
  const entries = Object.entries(form.requestedSchema.properties);
  if (answers.length !== entries.length) return { action: "cancel" };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [[key, property], answer] of entries.map(
    (entry, index) => [entry, answers[index]] as const,
  )) {
    if (answer === undefined) return { action: "cancel" };
    if (answer.length === 0) {
      if (form.requestedSchema.required.has(key)) return { action: "cancel" };
      continue;
    }
    const value = formValue(property, answer);
    if (value === undefined) return { action: "cancel" };
    content[key] = value;
  }
  return { action: "accept", content };
}

function formValue(
  property: Record<string, unknown>,
  answers: string[],
): string | number | boolean | string[] | undefined {
  const type = property.type;
  if (type === "array") {
    if (!isRecord(property.items)) return undefined;
    const items = property.items;
    const values: string[] = [];
    for (const answer of answers) {
      const value = optionValue(items, answer);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  if (answers.length !== 1) return undefined;
  const selected = optionValue(property, answers[0] ?? "");
  if (selected === undefined) return undefined;
  if (type === "string") return selected;
  if (type === "boolean") {
    const normalised = selected.toLowerCase();
    if (normalised === "yes" || normalised === "true") return true;
    if (normalised === "no" || normalised === "false") return false;
    return undefined;
  }
  if (type !== "number" && type !== "integer") return undefined;
  const number = Number(selected);
  if (
    !Number.isFinite(number) ||
    (type === "integer" && !Number.isInteger(number))
  )
    return undefined;
  if (typeof property.minimum === "number" && number < property.minimum)
    return undefined;
  if (typeof property.maximum === "number" && number > property.maximum)
    return undefined;
  return number;
}

function optionValue(
  schema: Record<string, unknown>,
  answer: string,
): string | undefined {
  if (Array.isArray(schema.enum)) {
    const values: unknown[] = schema.enum;
    for (const value of values) {
      if (typeof value === "string" && value === answer) return value;
    }
    return undefined;
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives !== undefined) {
    const candidates: unknown[] = alternatives;
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const label =
        typeof candidate.label === "string" ? candidate.label : candidate.title;
      const value =
        typeof candidate.const === "string"
          ? candidate.const
          : typeof candidate.value === "string"
            ? candidate.value
            : undefined;
      if (value !== undefined && (answer === label || answer === value))
        return value;
    }
    return undefined;
  }
  return answer;
}

function parseFormRequest(request: unknown): FormRequest | undefined {
  if (
    !isRecord(request) ||
    request.mode !== "form" ||
    !isRecord(request.requestedSchema) ||
    !isRecord(request.requestedSchema.properties) ||
    Object.keys(request.requestedSchema.properties).length === 0
  ) {
    return undefined;
  }
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(
    request.requestedSchema.properties,
  )) {
    if (!isRecord(value) || !isProjectableFormProperty(value)) return undefined;
    properties[key] = value;
  }
  const required = request.requestedSchema.required;
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      !required.every((value) => typeof value === "string"))
  ) {
    return undefined;
  }
  const requiredKeys = new Set<string>();
  if (Array.isArray(required)) {
    const values: unknown[] = required;
    for (const value of values) {
      if (typeof value === "string") requiredKeys.add(value);
    }
  }
  return {
    mode: "form",
    requestedSchema: {
      properties,
      required: requiredKeys,
    },
  };
}

function isProjectableFormProperty(value: Record<string, unknown>): boolean {
  if (
    value.type === "string" ||
    value.type === "number" ||
    value.type === "integer" ||
    value.type === "boolean"
  ) {
    return true;
  }
  return value.type === "array" && isRecord(value.items);
}

function cursorResponse(params: unknown, answers: string[][]): object {
  const questions = parseCursorQuestions(params);
  if (questions === undefined || answers.length !== questions.length)
    return { outcome: { outcome: "cancelled" } };
  const mapped: { questionId: string; selectedOptionIds: string[] }[] = [];
  for (const [index, question] of questions.entries()) {
    const answer = answers[index];
    if (
      answer === undefined ||
      answer.length === 0 ||
      (!question.allowMultiple && answer.length !== 1)
    ) {
      return { outcome: { outcome: "cancelled" } };
    }
    const selectedOptionIds: string[] = [];
    for (const selected of answer) {
      const option = question.options.find(
        (candidate) =>
          candidate.id === selected || candidate.label === selected,
      );
      if (option === undefined) return { outcome: { outcome: "cancelled" } };
      selectedOptionIds.push(option.id);
    }
    mapped.push({ questionId: question.id, selectedOptionIds });
  }
  return { outcome: { outcome: "answered", answers: mapped } };
}

function parseCursorQuestions(params: unknown): CursorQuestion[] | undefined {
  if (
    !isRecord(params) ||
    !Array.isArray(params.questions) ||
    params.questions.length === 0
  ) {
    return undefined;
  }
  const result: CursorQuestion[] = [];
  for (const value of params.questions) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.prompt !== "string" ||
      !Array.isArray(value.options) ||
      value.options.length === 0
    ) {
      return undefined;
    }
    const options: CursorQuestion["options"] = [];
    for (const option of value.options) {
      if (
        !isRecord(option) ||
        typeof option.id !== "string" ||
        typeof option.label !== "string"
      ) {
        return undefined;
      }
      options.push({ id: option.id, label: option.label });
    }
    result.push({
      id: value.id,
      allowMultiple: value.allowMultiple === true,
      options,
    });
  }
  return result;
}

function isQuestionAskedEvent(value: unknown): value is QuestionAskedEvent {
  if (!isRecord(value) || value.type !== "question.asked") return false;
  const properties = value.properties;
  return (
    isRecord(properties) &&
    typeof properties.id === "string" &&
    typeof properties.sessionID === "string" &&
    isRecord(properties.tool) &&
    typeof properties.tool.callID === "string"
  );
}

function isQuestionRejectedEvent(
  value: unknown,
): value is QuestionRejectedEvent {
  if (!isRecord(value) || value.type !== "question.rejected") return false;
  const properties = value.properties;
  return (
    isRecord(properties) &&
    typeof properties.sessionID === "string" &&
    typeof properties.requestID === "string"
  );
}

function questionRequestKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`;
}

function cancellationFor(method: string): object {
  if (method === "elicitation/create")
    return { response: { action: "cancel" } };
  if (method === "cursor/ask_question" || method === "cursor/create_plan") {
    return { result: { outcome: { outcome: "cancelled" } } };
  }
  return {
    error: {
      code: "ACP_INTERACTION_UNAVAILABLE",
      message: "No compatible OpenCode interaction renderer is available",
    },
  };
}

function genericResult(
  input: GenericInteractionToolInput,
  outcome: object,
  reason?: string,
): ToolResult {
  return {
    title: "ACP interaction completed",
    output: JSON.stringify({
      interactionId: input.interactionId,
      method: input.method,
      ...outcome,
    }),
    metadata: {
      interactionId: input.interactionId,
      method: input.method,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

function planTitle(value: unknown): string {
  if (!isRecord(value)) return "Approve ACP plan";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  return name.length === 0
    ? "Approve ACP plan"
    : `Approve ACP plan: ${name.slice(0, 256)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
