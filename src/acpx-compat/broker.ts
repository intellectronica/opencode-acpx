import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpRuntimeEvent } from "acpx/runtime";

import type {
  AcpCompatAuthMetadata,
  AcpCompatAuthMethod,
  AcpCompatAuthObservation,
  AcpCompatCallbacks,
  AcpCompatDiagnostic,
  AcpCompatInvocationContext,
  AcpCompatRawMessageInput,
  AcpCompatRouteContext,
  CursorAskQuestionResponse,
  CursorCreatePlanResponse,
} from "./contracts.js";
import {
  CURSOR_ASK_QUESTION_METHOD,
  CURSOR_CREATE_PLAN_METHOD,
  parseCursorAskQuestionRequest,
  parseCursorCreatePlanRequest,
  validateCursorAskQuestionResponse,
  validateCursorCreatePlanResponse,
} from "./cursor.js";
import { AcpCompatError, isAcpCompatError } from "./errors.js";

const DEFAULT_INTERACTION_TIMEOUT_MS = 120_000;

export interface AcpCompatBrokerOptions {
  callbacks?: AcpCompatCallbacks;
  interactionTimeoutMs?: number;
  now?: () => number;
  createInteractionId?: (sequence: number) => string;
}

export interface AcpCompatRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class AcpCompatBroker {
  readonly #callbacks: AcpCompatCallbacks;
  readonly #interactionTimeoutMs: number;
  readonly #now: () => number;
  readonly #createInteractionId: (sequence: number) => string;
  readonly #diagnostics: AcpCompatDiagnostic[] = [];
  readonly #active = new Map<
    string,
    { controller: AbortController; context: AcpCompatRouteContext }
  >();
  #sequence = 0;

  constructor(options: AcpCompatBrokerOptions = {}) {
    this.#callbacks = options.callbacks ?? {};
    this.#interactionTimeoutMs = requirePositiveTimeout(
      options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS,
    );
    this.#now = options.now ?? Date.now;
    this.#createInteractionId =
      options.createInteractionId ??
      ((sequence) => `acpx-compat-${String(sequence)}`);
  }

  get diagnostics(): readonly AcpCompatDiagnostic[] {
    return this.#diagnostics;
  }

  get activeInteractionCount(): number {
    return this.#active.size;
  }

  cancelWhere(
    predicate: (context: AcpCompatRouteContext) => boolean,
    reason = "ACP compatibility interaction cancelled",
  ): number {
    let cancelled = 0;
    for (const { controller, context } of this.#active.values()) {
      if (!predicate(context) || controller.signal.aborted) continue;
      controller.abort(new Error(reason));
      cancelled += 1;
    }
    return cancelled;
  }

  dispose(reason = "ACP compatibility broker disposed"): void {
    for (const { controller } of this.#active.values()) {
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    }
  }

  async observeRawMessage(input: AcpCompatRawMessageInput): Promise<void> {
    const sequence = this.#nextSequence();
    await this.#safeObserver("onRawMessage", () =>
      this.#callbacks.onRawMessage?.({
        ...input,
        observedAt: this.#now(),
        sequence,
      }),
    );
  }

  async handleElicitation(
    request: CreateElicitationRequest,
    context: AcpCompatRouteContext,
    options: AcpCompatRequestOptions = {},
  ): Promise<CreateElicitationResponse> {
    if (this.#callbacks.onElicitation === undefined) {
      await this.diagnose({
        code: "UNSUPPORTED_ELICITATION",
        severity: "warning",
        message:
          "The ACP server requested elicitation, but no elicitation callback is installed",
        context,
      });
      return { action: "cancel" };
    }

    try {
      const response = await this.#runRequest(
        context,
        "elicitation/create",
        options,
        (invocation) =>
          this.#callbacks.onElicitation?.({ request, context: invocation }),
      );
      if (!isElicitationResponse(response)) {
        throw new AcpCompatError(
          "ACP_COMPAT_INVALID_PARAMS",
          "The elicitation callback returned an invalid response",
          { method: "elicitation/create" },
        );
      }
      return response;
    } catch (error) {
      await this.#diagnoseRequestFailure(error, "elicitation/create", context);
      return { action: "cancel" };
    }
  }

  async observeElicitationCompleted(
    notification: Parameters<
      NonNullable<AcpCompatCallbacks["onElicitationCompleted"]>
    >[0]["notification"],
    context: AcpCompatRouteContext,
  ): Promise<void> {
    await this.#safeObserver("onElicitationCompleted", () =>
      this.#callbacks.onElicitationCompleted?.({ notification, context }),
    );
  }

  async handleReverseRequest(
    method: string,
    params: unknown,
    context: AcpCompatRouteContext,
    options: AcpCompatRequestOptions = {},
  ): Promise<unknown> {
    if (method.trim().length === 0) {
      throw new AcpCompatError(
        "ACP_COMPAT_INVALID_PARAMS",
        "Extension method must not be empty",
      );
    }
    if (method === CURSOR_ASK_QUESTION_METHOD) {
      return this.#handleCursorQuestion(params, context, options);
    }
    if (method === CURSOR_CREATE_PLAN_METHOD) {
      return this.#handleCursorPlan(params, context, options);
    }
    if (this.#callbacks.onReverseRequest === undefined) {
      await this.diagnose({
        code: "UNSUPPORTED_REVERSE_REQUEST",
        severity: "error",
        message: `No reverse request handler is installed for ${method}`,
        method,
        context,
      });
      throw new AcpCompatError(
        "ACP_COMPAT_UNSUPPORTED",
        `Unsupported ACP reverse request: ${method}`,
        { method },
      );
    }

    try {
      return await this.#runRequest(context, method, options, (invocation) =>
        this.#callbacks.onReverseRequest?.({
          method,
          params,
          context: invocation,
        }),
      );
    } catch (error) {
      await this.#diagnoseRequestFailure(error, method, context);
      if (isAcpCompatError(error)) throw error;
      throw new AcpCompatError(
        "ACP_COMPAT_HANDLER_FAILED",
        `ACP reverse request handler failed for ${method}`,
        { method, cause: error },
      );
    }
  }

  async observeReverseNotification(
    method: string,
    params: unknown,
    context: AcpCompatRouteContext,
  ): Promise<void> {
    const sequence = this.#nextSequence();
    if (this.#callbacks.onReverseNotification === undefined) {
      await this.diagnose({
        code: "UNHANDLED_REVERSE_NOTIFICATION",
        severity: "warning",
        message: `No reverse notification observer is installed for ${method}`,
        method,
        context,
      });
      return;
    }
    await this.#safeObserver("onReverseNotification", () =>
      this.#callbacks.onReverseNotification?.({
        method,
        params,
        context: { ...context, observedAt: this.#now(), sequence },
      }),
    );
  }

  async observeAuthMetadata(
    observation: AcpCompatAuthObservation,
    context: AcpCompatRouteContext,
  ): Promise<void> {
    const metadata: AcpCompatAuthMetadata = {
      status: observation.status,
      methods: observation.methods.map(sanitiseAuthMethod),
      observedAt: this.#now(),
      sequence: this.#nextSequence(),
      context,
    };
    if (observation.selectedMethodId !== undefined) {
      metadata.selectedMethodId = observation.selectedMethodId;
    }
    if (observation.failureMessage !== undefined)
      metadata.failureMessage = observation.failureMessage;
    await this.#safeObserver("onAuthMetadata", () =>
      this.#callbacks.onAuthMetadata?.(metadata),
    );
  }

  async observeSessionUpdate(
    notification: SessionNotification,
    context: AcpCompatRouteContext,
  ): Promise<void> {
    await this.#safeObserver("onSessionUpdate", () =>
      this.#callbacks.onSessionUpdate?.(notification),
    );
    const update = notification.update;
    if (update.sessionUpdate === "available_commands_update") {
      await this.#safeObserver("onCommandUpdate", () =>
        this.#callbacks.onCommandUpdate?.({
          commands: update.availableCommands,
          fidelity: "full",
          source: "protocol",
          context,
          raw: notification,
        }),
      );
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      await this.#safeObserver("onConfigUpdate", () =>
        this.#callbacks.onConfigUpdate?.({
          configOptions: update.configOptions,
          fidelity: "full",
          source: "protocol",
          context,
          raw: notification,
        }),
      );
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      await this.#safeObserver("onModeUpdate", () =>
        this.#callbacks.onModeUpdate?.({
          currentModeId: update.currentModeId,
          fidelity: "full",
          source: "protocol",
          context,
          raw: notification,
        }),
      );
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      await this.#safeObserver("onSessionInfoUpdate", () =>
        this.#callbacks.onSessionInfoUpdate?.({
          update,
          fidelity: "full",
          source: "protocol",
          context,
          raw: notification,
        }),
      );
    }
  }

  async observeRuntimeEvent(
    event: AcpRuntimeEvent,
    context: AcpCompatRouteContext,
  ): Promise<void> {
    if (event.type !== "status") return;
    if (event.tag === "available_commands_update") {
      await this.#safeObserver("onCommandUpdate", () =>
        this.#callbacks.onCommandUpdate?.({
          commands: event.availableCommands ?? [],
          fidelity: "reduced",
          source: "stock-runtime",
          context,
          raw: event,
        }),
      );
      return;
    }
    if (event.tag === "config_option_update") {
      await this.#safeObserver("onConfigUpdate", () =>
        this.#callbacks.onConfigUpdate?.({
          fidelity: "reduced",
          source: "stock-runtime",
          context,
          raw: event,
        }),
      );
      return;
    }
    if (event.tag === "current_mode_update") {
      await this.#safeObserver("onModeUpdate", () =>
        this.#callbacks.onModeUpdate?.({
          fidelity: "reduced",
          source: "stock-runtime",
          context,
          raw: event,
        }),
      );
      return;
    }
    if (event.tag === "session_info_update") {
      await this.#safeObserver("onSessionInfoUpdate", () =>
        this.#callbacks.onSessionInfoUpdate?.({
          fidelity: "reduced",
          source: "stock-runtime",
          context,
          raw: event,
        }),
      );
    }
  }

  async diagnose(diagnostic: AcpCompatDiagnostic): Promise<void> {
    this.#diagnostics.push(diagnostic);
    try {
      await this.#callbacks.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics must never disrupt the ACP transport or recurse into another diagnostic.
    }
  }

  async #handleCursorQuestion(
    params: unknown,
    context: AcpCompatRouteContext,
    options: AcpCompatRequestOptions,
  ): Promise<CursorAskQuestionResponse> {
    let request;
    try {
      request = parseCursorAskQuestionRequest(params);
    } catch (error) {
      await this.#diagnoseMalformedCursorRequest(
        error,
        CURSOR_ASK_QUESTION_METHOD,
        context,
      );
      throw error;
    }
    const callback = this.#callbacks.onCursorQuestion;
    const generic = this.#callbacks.onReverseRequest;
    if (callback === undefined && generic === undefined) {
      await this.diagnose({
        code: "UNSUPPORTED_REVERSE_REQUEST",
        severity: "error",
        message:
          "Cursor asked a question, but no Cursor question callback is installed",
        method: CURSOR_ASK_QUESTION_METHOD,
        context,
      });
      return { outcome: { outcome: "cancelled" } };
    }
    try {
      const response = (await this.#runRequest(
        context,
        CURSOR_ASK_QUESTION_METHOD,
        options,
        (invocation) =>
          callback !== undefined
            ? callback({
                method: CURSOR_ASK_QUESTION_METHOD,
                request,
                rawParams: params,
                context: invocation,
              })
            : generic?.({
                method: CURSOR_ASK_QUESTION_METHOD,
                params,
                context: invocation,
              }),
      )) as CursorAskQuestionResponse;
      validateCursorAskQuestionResponse(response);
      return response;
    } catch (error) {
      await this.#diagnoseRequestFailure(
        error,
        CURSOR_ASK_QUESTION_METHOD,
        context,
      );
      return { outcome: { outcome: "cancelled" } };
    }
  }

  async #handleCursorPlan(
    params: unknown,
    context: AcpCompatRouteContext,
    options: AcpCompatRequestOptions,
  ): Promise<CursorCreatePlanResponse> {
    let request;
    try {
      request = parseCursorCreatePlanRequest(params);
    } catch (error) {
      await this.#diagnoseMalformedCursorRequest(
        error,
        CURSOR_CREATE_PLAN_METHOD,
        context,
      );
      throw error;
    }
    const callback = this.#callbacks.onCursorPlan;
    const generic = this.#callbacks.onReverseRequest;
    if (callback === undefined && generic === undefined) {
      await this.diagnose({
        code: "UNSUPPORTED_REVERSE_REQUEST",
        severity: "error",
        message:
          "Cursor requested plan approval, but no Cursor plan callback is installed",
        method: CURSOR_CREATE_PLAN_METHOD,
        context,
      });
      return { outcome: { outcome: "cancelled" } };
    }
    try {
      const response = (await this.#runRequest(
        context,
        CURSOR_CREATE_PLAN_METHOD,
        options,
        (invocation) =>
          callback !== undefined
            ? callback({
                method: CURSOR_CREATE_PLAN_METHOD,
                request,
                rawParams: params,
                context: invocation,
              })
            : generic?.({
                method: CURSOR_CREATE_PLAN_METHOD,
                params,
                context: invocation,
              }),
      )) as CursorCreatePlanResponse;
      validateCursorCreatePlanResponse(response);
      return response;
    } catch (error) {
      await this.#diagnoseRequestFailure(
        error,
        CURSOR_CREATE_PLAN_METHOD,
        context,
      );
      return { outcome: { outcome: "cancelled" } };
    }
  }

  async #runRequest<T>(
    context: AcpCompatRouteContext,
    method: string,
    options: AcpCompatRequestOptions,
    callback: (
      context: AcpCompatInvocationContext,
    ) => T | Promise<T> | undefined,
  ): Promise<T> {
    const sequence = this.#nextSequence();
    const interactionId = this.#createInteractionId(sequence);
    const controller = new AbortController();
    const timeoutMs = requirePositiveTimeout(
      options.timeoutMs ?? this.#interactionTimeoutMs,
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    const abort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted === true) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    const invocation: AcpCompatInvocationContext = {
      ...context,
      interactionId,
      sequence,
      receivedAt: this.#now(),
      signal: controller.signal,
    };
    this.#active.set(interactionId, { controller, context });
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAborted = (): void => {
        reject(
          new AcpCompatError(
            "ACP_COMPAT_ABORTED",
            timedOut
              ? `ACP interaction timed out after ${String(timeoutMs)} ms`
              : "ACP interaction was aborted",
            { method, interactionId, cause: controller.signal.reason },
          ),
        );
      };
      if (controller.signal.aborted) rejectAborted();
      else
        controller.signal.addEventListener("abort", rejectAborted, {
          once: true,
        });
    });

    try {
      if (controller.signal.aborted) return await aborted;
      const task = Promise.resolve().then(() => callback(invocation));
      const result = await Promise.race([task, aborted]);
      if (result === undefined) {
        throw new AcpCompatError(
          "ACP_COMPAT_HANDLER_FAILED",
          `ACP callback returned no response for ${method}`,
          { method, interactionId },
        );
      }
      return result;
    } finally {
      this.#active.delete(interactionId);
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async #safeObserver(name: string, callback: () => unknown): Promise<void> {
    try {
      await callback();
    } catch (error) {
      await this.diagnose({
        code: "CALLBACK_FAILED",
        severity: "warning",
        message: `ACP compatibility observer ${name} failed and was isolated`,
        details: { error: errorMessage(error) },
      });
    }
  }

  async #diagnoseMalformedCursorRequest(
    error: unknown,
    method: string,
    context: AcpCompatRouteContext,
  ): Promise<void> {
    await this.diagnose({
      code: "MALFORMED_REVERSE_REQUEST",
      severity: "error",
      message: errorMessage(error),
      method,
      context,
    });
  }

  async #diagnoseRequestFailure(
    error: unknown,
    method: string,
    context: AcpCompatRouteContext,
  ): Promise<void> {
    const aborted =
      isAcpCompatError(error) && error.code === "ACP_COMPAT_ABORTED";
    const timedOut = aborted && error.message.includes("timed out");
    await this.diagnose({
      code: timedOut
        ? "INTERACTION_TIMED_OUT"
        : aborted
          ? "INTERACTION_ABORTED"
          : "CALLBACK_FAILED",
      severity: "error",
      message: errorMessage(error),
      method,
      context,
      ...(isAcpCompatError(error) && error.interactionId !== undefined
        ? { interactionId: error.interactionId }
        : {}),
    });
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }
}

function sanitiseAuthMethod(
  method: AcpCompatAuthObservation["methods"][number],
): AcpCompatAuthMethod {
  const record = method as unknown as Record<string, unknown>;
  const type =
    record.type === "env_var" || record.type === "terminal"
      ? record.type
      : "agent";
  const result: AcpCompatAuthMethod = {
    id: method.id,
    name: method.name,
    type,
  };
  if (typeof method.description === "string")
    result.description = method.description;
  if (type === "env_var") {
    const variables = Array.isArray(record.vars)
      ? record.vars
          .filter(isRecord)
          .filter((variable) => typeof variable.name === "string")
      : [];
    result.variableNames = variables.map((variable) => variable.name as string);
    result.secretVariableNames = variables
      .filter((variable) => variable.secret !== false)
      .map((variable) => variable.name as string);
    result.optionalVariableNames = variables
      .filter((variable) => variable.optional === true)
      .map((variable) => variable.name as string);
    if (typeof record.link === "string") result.link = record.link;
  }
  if (type === "terminal") {
    if (
      Array.isArray(record.args) &&
      record.args.every((argument) => typeof argument === "string")
    ) {
      result.arguments = [...record.args] as string[];
    }
    if (isRecord(record.env))
      result.environmentNames = Object.keys(record.env).sort();
  }
  return result;
}

function isElicitationResponse(
  value: unknown,
): value is CreateElicitationResponse {
  if (
    !isRecord(value) ||
    typeof value.action !== "string" ||
    value.action.trim().length === 0
  )
    return false;
  if (value.action !== "accept") return true;
  if (value.content === undefined || value.content === null) return true;
  if (!isRecord(value.content)) return false;
  return Object.values(value.content).every(
    (entry) =>
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      (Array.isArray(entry) && entry.every((item) => typeof item === "string")),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePositiveTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      "ACP compatibility interaction timeout must be a positive finite number",
    );
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
