import { createHash } from "node:crypto";

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import type {
  AcpRuntimeTurnResult,
  AcpRuntimeUsageBreakdown,
} from "acpx/runtime";

import { getProviderRuntime, type ProviderRuntime } from "./registry.js";
import { createSessionKey } from "./session/identity.js";
import { createBindingRecord } from "./session/ledger.js";
import { collectGenerateResult } from "./translate/generate.js";
import {
  readCallRouting,
  hasQuestionResult,
  readGenericInteractionResponse,
  readLatestUserPrompt,
  readPermissionDecision,
  type AcpxCallRouting,
} from "./translate/input.js";
import {
  AcpStreamTranslator,
  permissionToolCallId,
} from "./translate/stream.js";
import type {
  ElicitationInteraction,
  ExtensionInteraction,
  PermissionInteraction,
  RuntimeWorkerEvent,
} from "./worker/messages.js";
import type { TurnChannel } from "./worker/turn-channel.js";

export interface AcpxProviderFactoryOptions {
  name: string;
  pluginInstanceId: string;
  serverId: string;
}

export interface AcpxProvider {
  readonly specificationVersion: "v3";
  languageModel(modelId: string): LanguageModelV3;
}

interface PendingPermission {
  kind: "permission";
  event: PermissionInteraction;
  toolCallId: string;
  response?: Promise<void>;
}

interface PendingGenericInteraction {
  kind: "generic";
  event: ElicitationInteraction | ExtensionInteraction;
  toolCallId: string;
  owner: "provider" | "server";
  response?: Promise<void>;
}

interface TurnState {
  turnId: string;
  sessionKey: string;
  discardSessionOnComplete: boolean;
  channel: Promise<TurnChannel>;
  cursor: number;
  segmentStartCursor: number;
  pendingInteraction?: PendingPermission | PendingGenericInteraction;
  terminal?: AcpRuntimeTurnResult;
  usage: AcpRuntimeUsageBreakdown | undefined;
  lastAccess: number;
  events: RuntimeWorkerEvent[];
  waiters: Set<() => void>;
  failure: Error | undefined;
}

interface RuntimeHub {
  turns: Map<string, TurnState>;
  orphans: Map<string, RuntimeWorkerEvent[]>;
  unsubscribe: () => void;
}

const hubsByRuntime = new WeakMap<ProviderRuntime, RuntimeHub>();
const MAX_REPLAY_TURNS_PER_RUNTIME = 256;
const INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"]);

function requiredFactoryOption(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `ACP provider factory option ${field} must be a non-empty string`,
    );
  }
  return value;
}

function digest(...values: string[]): string {
  const hash = createHash("sha256");
  for (const value of values)
    hash.update(`${String(value.length)}:`).update(value);
  return hash.digest("hex");
}

function pushStateEvent(state: TurnState, event: RuntimeWorkerEvent): void {
  state.events.push(event);
  if (event.type === "turn.result") state.terminal = event.result;
  for (const wake of state.waiters) wake();
  state.waiters.clear();
}

function failState(state: TurnState, error: Error): void {
  state.failure ??= error;
  for (const wake of state.waiters) wake();
  state.waiters.clear();
}

function runtimeHub(runtime: ProviderRuntime): RuntimeHub {
  const existing = hubsByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const hub: RuntimeHub = {
    turns: new Map(),
    orphans: new Map(),
    unsubscribe: () => undefined,
  };
  hubsByRuntime.set(runtime, hub);
  hub.unsubscribe = runtime.client.subscribe((event) => {
    if (
      (event.type !== "interaction.elicitation" &&
        event.type !== "interaction.extension" &&
        event.type !== "extension.notification") ||
      event.turnId === undefined
    ) {
      return;
    }
    const state = hub.turns.get(event.turnId);
    if (state !== undefined) {
      pushStateEvent(state, event);
      return;
    }
    const pending = hub.orphans.get(event.turnId) ?? [];
    pending.push(event);
    hub.orphans.set(event.turnId, pending);
  });
  return hub;
}

async function forwardTurnChannel(state: TurnState): Promise<void> {
  try {
    const channel = await state.channel;
    for await (const event of channel.events()) pushStateEvent(state, event);
  } catch (error) {
    failState(state, error instanceof Error ? error : new Error(String(error)));
  }
}

async function* stateEvents(
  state: TurnState,
  cursor: number,
  signal: AbortSignal,
): AsyncGenerator<RuntimeWorkerEvent> {
  let index = cursor;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    if (state.failure !== undefined) throw state.failure;
    const event = state.events[index];
    if (event !== undefined) {
      index += 1;
      yield event;
      if (event.type === "turn.result") return;
      continue;
    }
    if (state.terminal !== undefined) return;
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = (): void => {
        state.waiters.delete(wake);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("ACP turn event wait was aborted"),
        );
      };
      state.waiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function pruneReplayTurns(turns: Map<string, TurnState>): void {
  if (turns.size < MAX_REPLAY_TURNS_PER_RUNTIME) return;
  const completed = [...turns.entries()]
    .filter(([, state]) => state.terminal?.status === "completed")
    .sort(([, left], [, right]) => left.lastAccess - right.lastAccess);
  for (const [turnId] of completed) {
    turns.delete(turnId);
    if (turns.size < MAX_REPLAY_TURNS_PER_RUNTIME) return;
  }
}

async function ensureLedgerBinding(
  runtime: ProviderRuntime,
  sessionKey: string,
  routing: AcpxCallRouting,
  modelId: string,
): Promise<void> {
  if (runtime.ledger === undefined) return;
  const existing = await runtime.ledger.get(sessionKey);
  if (existing !== undefined) return;
  const binding = createBindingRecord({
    sessionKey,
    serverId: runtime.serverId,
    openCodeSessionId: routing.openCodeSessionId,
    worktree: runtime.worktree,
    generation: routing.generation,
  });
  binding.selectedModel = modelId;
  await runtime.ledger.put(sessionKey, binding);
}

function runtimeFor(options: AcpxProviderFactoryOptions): ProviderRuntime {
  const runtime = getProviderRuntime(options.pluginInstanceId, options.name);
  if (runtime === undefined) {
    throw new Error(
      `No ACP provider runtime is registered for ${options.pluginInstanceId}/${options.name}`,
    );
  }
  if (runtime.serverId !== options.serverId) {
    throw new Error(
      `ACP provider ${options.name} is registered for a different server`,
    );
  }
  return runtime;
}

async function resolveTurn(
  runtime: ProviderRuntime,
  providerId: string,
  modelId: string,
  routing: AcpxCallRouting,
  call: LanguageModelV3CallOptions,
): Promise<TurnState> {
  const sessionKey = await createSessionKey({
    serverId: runtime.serverId,
    server: runtime.server,
    worktree: runtime.worktree,
    openCodeSessionId:
      routing.agent !== undefined && INTERNAL_AGENT_NAMES.has(routing.agent)
        ? `${routing.openCodeSessionId}:internal:${routing.agent}:${routing.requestId}`
        : routing.openCodeSessionId,
    generation: routing.generation,
  });
  const turnId = `opencode-acpx-turn-${digest(
    runtime.pluginInstanceId,
    providerId,
    modelId,
    sessionKey,
    routing.requestId,
  )}`;
  const hub = runtimeHub(runtime);
  const turns = hub.turns;
  const existing = turns.get(turnId);
  if (existing !== undefined) {
    existing.lastAccess = Date.now();
    return existing;
  }
  await ensureLedgerBinding(runtime, sessionKey, routing, modelId);
  pruneReplayTurns(turns);
  const prompt = readLatestUserPrompt(call.prompt);
  const channel = runtime.client.startTurn({
    turnId,
    serverId: runtime.serverId,
    sessionKey,
    cwd: runtime.server.cwd ?? runtime.directory,
    requestId: routing.requestId,
    text: prompt.text,
    ...(modelId === "default" ? {} : { modelId }),
    ...(routing.mode === undefined ? {} : { mode: routing.mode }),
    ...(prompt.attachments === undefined
      ? {}
      : { attachments: prompt.attachments }),
  });
  const state: TurnState = {
    turnId,
    sessionKey,
    discardSessionOnComplete:
      routing.agent !== undefined && INTERNAL_AGENT_NAMES.has(routing.agent),
    channel,
    cursor: 0,
    segmentStartCursor: 0,
    usage: undefined,
    lastAccess: Date.now(),
    events: [],
    waiters: new Set(),
    failure: undefined,
  };
  turns.set(turnId, state);
  for (const event of hub.orphans.get(turnId) ?? [])
    pushStateEvent(state, event);
  hub.orphans.delete(turnId);
  void forwardTurnChannel(state);
  return state;
}

async function continuePermission(
  runtime: ProviderRuntime,
  state: TurnState,
  call: LanguageModelV3CallOptions,
): Promise<boolean> {
  const pending = state.pendingInteraction;
  if (pending?.kind !== "permission") return false;
  const decision = readPermissionDecision(
    call.prompt,
    pending.toolCallId,
    pending.event.interactionId,
  );
  if (decision === undefined) return false;
  pending.response ??= runtime.client
    .respondPermission(pending.event.interactionId, decision)
    .then(() => undefined);
  await pending.response;
  state.segmentStartCursor = state.cursor;
  delete state.pendingInteraction;
  return true;
}

async function continueGenericInteraction(
  runtime: ProviderRuntime,
  state: TurnState,
  call: LanguageModelV3CallOptions,
): Promise<boolean> {
  const pending = state.pendingInteraction;
  if (pending?.kind !== "generic") return false;
  if (pending.owner === "server") {
    if (!hasQuestionResult(call.prompt, pending.toolCallId)) return false;
  } else {
    const response = readGenericInteractionResponse(
      call.prompt,
      pending.toolCallId,
      pending.event,
    );
    if (response === undefined) return false;
    pending.response ??=
      response.kind === "elicitation"
        ? runtime.client
            .respondElicitation(response.interactionId, response.response)
            .then(() => undefined)
        : runtime.client
            .respondExtension(response.params)
            .then(() => undefined);
    await pending.response;
  }
  state.segmentStartCursor = state.cursor;
  delete state.pendingInteraction;
  return true;
}

function failClosedGenericInteraction(
  runtime: ProviderRuntime,
  event: ElicitationInteraction | ExtensionInteraction,
): Promise<unknown> {
  if (event.type === "interaction.elicitation") {
    return runtime.client.respondElicitation(event.interactionId, {
      action: "cancel",
    });
  }
  if (
    event.method === "cursor/ask_question" ||
    event.method === "cursor/create_plan"
  ) {
    return runtime.client.respondExtension({
      interactionId: event.interactionId,
      result: { outcome: { outcome: "cancelled" } },
    });
  }
  return runtime.client.respondExtension({
    interactionId: event.interactionId,
    error: {
      code: "ACP_INTERACTION_UNAVAILABLE",
      message: "No compatible OpenCode interaction renderer is available",
    },
  });
}

function isInformationalCursorExtension(event: ExtensionInteraction): boolean {
  return (
    event.method === "cursor/task" || event.method === "cursor/update_todos"
  );
}

function updateState(
  state: TurnState,
  event: RuntimeWorkerEvent,
  cursor: number,
): void {
  state.cursor = Math.max(state.cursor, cursor);
  if (event.type === "turn.result") state.terminal = event.result;
  if (
    event.type === "turn.event" &&
    event.event.type === "status" &&
    event.event.breakdown !== undefined
  ) {
    state.usage = event.event.breakdown;
  }
}

function streamTurn(
  runtime: ProviderRuntime,
  state: TurnState,
  call: LanguageModelV3CallOptions,
  startCursor: number,
): LanguageModelV3StreamResult {
  let cancelled = false;
  let cancellation: Promise<void> | undefined;
  const lifecycle = new AbortController();
  const signal =
    call.abortSignal === undefined
      ? lifecycle.signal
      : AbortSignal.any([call.abortSignal, lifecycle.signal]);
  const cancellationReason = (reason: unknown): string => {
    if (typeof reason === "string") return reason;
    if (reason instanceof Error) return reason.message;
    return reason === undefined
      ? "cancelled by OpenCode"
      : "OpenCode cancelled the stream";
  };
  const cancelWorker = (reason: unknown): Promise<void> => {
    cancelled = true;
    cancellation ??= runtime.client
      .cancelTurn(state.turnId, cancellationReason(reason))
      .then(() => undefined)
      .catch(() => undefined);
    return cancellation;
  };
  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      const translator = new AcpStreamTranslator(state.turnId, state.usage);
      const abort = (): void => {
        void cancelWorker(signal.reason);
      };
      if (signal.aborted) {
        abort();
        controller.error(signal.reason);
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "response-metadata", id: state.turnId });
      let cursor = startCursor;
      try {
        for await (const event of stateEvents(state, startCursor, signal)) {
          cursor += 1;
          updateState(state, event, cursor);
          if (event.type === "turn.event") {
            for (const part of translator.event(event.event, event.index))
              controller.enqueue(part);
            continue;
          }
          if (event.type === "interaction.permission") {
            const pending: PendingPermission = {
              kind: "permission",
              event,
              toolCallId: permissionToolCallId(event.interactionId),
            };
            state.pendingInteraction = pending;
            for (const part of translator.permission(event))
              controller.enqueue(part);
            state.usage = translator.usage;
            controller.close();
            return;
          }
          if (
            event.type === "interaction.elicitation" ||
            event.type === "interaction.extension"
          ) {
            if (
              event.type === "interaction.extension" &&
              isInformationalCursorExtension(event)
            ) {
              for (const part of translator.extensionNotification({
                type: "extension.notification",
                serverId: event.serverId,
                ...(event.sessionKey === undefined
                  ? {}
                  : { sessionKey: event.sessionKey }),
                ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
                method: event.method,
                params: event.params,
              }))
                controller.enqueue(part);
              await runtime.client.respondExtension({
                interactionId: event.interactionId,
                result: {},
              });
              continue;
            }
            const projection = translator.interaction(event);
            if (projection === undefined) {
              await failClosedGenericInteraction(runtime, event);
              continue;
            }
            state.pendingInteraction = {
              kind: "generic",
              event,
              toolCallId: projection.toolCallId,
              owner: projection.owner,
            };
            for (const part of projection.parts) controller.enqueue(part);
            state.usage = translator.usage;
            controller.close();
            return;
          }
          if (event.type === "extension.notification") {
            for (const part of translator.extensionNotification(event))
              controller.enqueue(part);
            continue;
          }
          if (event.type === "turn.result") {
            for (const part of translator.terminal(event.result))
              controller.enqueue(part);
            state.usage = translator.usage;
            if (state.discardSessionOnComplete) {
              await runtime.client
                .closeSession(runtime.serverId, state.sessionKey, true)
                .catch(() => undefined);
            }
            controller.close();
            return;
          }
        }
        controller.close();
      } catch (error) {
        if (!cancelled) {
          controller.enqueue({ type: "error", error });
          controller.enqueue({
            type: "finish",
            usage: {
              inputTokens: {
                total: undefined,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: undefined,
                text: undefined,
                reasoning: undefined,
              },
            },
            finishReason: { unified: "error", raw: "worker-stream-error" },
          });
          controller.close();
        } else {
          controller.error(error);
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    async cancel(reason) {
      lifecycle.abort(reason ?? "stream cancelled");
      await cancelWorker(reason);
    },
  });
  return { stream, request: { body: { turnId: state.turnId } } };
}

class AcpxLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  readonly #factoryOptions: AcpxProviderFactoryOptions;

  constructor(
    readonly provider: string,
    readonly modelId: string,
    factoryOptions: AcpxProviderFactoryOptions,
  ) {
    this.#factoryOptions = factoryOptions;
  }

  async doStream(
    call: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const runtime = runtimeFor(this.#factoryOptions);
    const routing = readCallRouting(call, this.provider);
    const state = await resolveTurn(
      runtime,
      this.provider,
      this.modelId,
      routing,
      call,
    );
    await continuePermission(runtime, state, call);
    await continueGenericInteraction(runtime, state, call);
    return streamTurn(runtime, state, call, state.segmentStartCursor);
  }

  async doGenerate(call: LanguageModelV3CallOptions) {
    return collectGenerateResult(await this.doStream(call));
  }
}

/** The sole `create*` export: OpenCode selects provider factories by name. */
export function createOpencodeAcpx(
  options: AcpxProviderFactoryOptions,
): AcpxProvider {
  const factoryOptions = {
    name: requiredFactoryOption(options.name, "name"),
    pluginInstanceId: requiredFactoryOption(
      options.pluginInstanceId,
      "pluginInstanceId",
    ),
    serverId: requiredFactoryOption(options.serverId, "serverId"),
  };
  return {
    specificationVersion: "v3",
    languageModel(modelId: string) {
      return new AcpxLanguageModel(
        factoryOptions.name,
        requiredFactoryOption(modelId, "modelId"),
        factoryOptions,
      );
    },
  };
}
