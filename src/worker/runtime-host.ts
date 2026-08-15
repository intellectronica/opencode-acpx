import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import * as acpxRuntime from "acpx/runtime";
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpRuntime,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
  type SessionAgentOptions,
} from "acpx/runtime";
import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";

import {
  expandHome,
  type PluginOptions,
  type ServerConfig,
} from "../config.js";
import { DEFAULT_INTERACTION_TIMEOUT_MS } from "../constants.js";
import { resolveRuntimeCommand } from "../runtime-command.js";
import { KeyedQueue } from "../session/keyed-queue.js";
import type {
  CatalogueModel,
  CatalogueParams,
  CatalogueResult,
  ConfigureParams,
  ElicitationResponseParams,
  ExtensionResponseParams,
  InteractionResponseParams,
  PermissionInteraction,
  RuntimeWorkerEvent,
  TurnCancelResult,
  TurnStartParams,
  TurnStartResult,
  WorkerCapabilityReport,
  WorkerDiagnostic,
} from "./messages.js";

const runtimeExports: Record<string, unknown> = acpxRuntime;
const HAS_ACPX_COMPAT_HOOKS =
  runtimeExports.ACPX_RUNTIME_COMPAT_HOOKS_VERSION === 1;

const DISPOSE_GRACE_MS = 5_000;
const MINIMUM_IDLE_SWEEP_INTERVAL_MS = 1_000;
const MAXIMUM_IDLE_SWEEP_INTERVAL_MS = 60_000;

export const STOCK_ACPX_FEATURE_SUPPORT: WorkerCapabilityReport = {
  permissions: { supported: true },
  extensions: {
    supported: false,
    code: "ACPX_RUNTIME_EXTENSIONS_UNAVAILABLE",
    message:
      "Acpx 0.13.0 does not expose generic ACP extension requests through acpx/runtime.",
  },
  elicitation: {
    supported: false,
    code: "ACPX_RUNTIME_ELICITATION_UNAVAILABLE",
    message:
      "Acpx 0.13.0 does not expose ACP elicitation through acpx/runtime.",
  },
  rawProtocolEvents: {
    supported: false,
    code: "ACPX_RUNTIME_RAW_EVENTS_UNAVAILABLE",
    message:
      "Acpx 0.13.0 normalises runtime events and does not expose the raw ACP stream.",
  },
  clientCapabilityControl: {
    supported: false,
    code: "ACPX_RUNTIME_CLIENT_CAPABILITIES_FIXED",
    message:
      "Acpx 0.13.0 does not expose filesystem, terminal or elicitation capability overrides through acpx/runtime.",
  },
};

export const PATCHED_ACPX_FEATURE_SUPPORT: WorkerCapabilityReport = {
  permissions: { supported: true },
  extensions: { supported: true },
  elicitation: { supported: true },
  rawProtocolEvents: { supported: true },
  clientCapabilityControl: {
    supported: false,
    code: "ACPX_RUNTIME_CLIENT_CAPABILITIES_PARTIAL",
    message:
      "The compatibility hooks advertise elicitation, but filesystem and terminal capability overrides remain fixed by Acpx.",
  },
};

interface HandleEntry {
  handle: AcpRuntimeHandle;
  lastUsedAt: number;
}

interface RuntimeEntry {
  serverId: string;
  server: ServerConfig;
  runtime: AcpRuntime;
  handles: Map<string, HandleEntry>;
}

type TurnState = "queued" | "active" | "terminal";

interface TurnRecord {
  params: TurnStartParams;
  fingerprint: string;
  requestKey: string;
  state: TurnState;
  index: number;
  abortController: AbortController;
  lastUsedAt: number;
  toolCallKeys: Set<string>;
  turn?: AcpRuntimeTurn;
  result?: AcpRuntimeTurnResult;
  task?: Promise<void>;
}

interface PendingInteraction {
  interactionId: string;
  turnId: string;
  sessionKey: string;
  expiresAt: number;
  request: AcpPermissionRequest;
  resolve: (decision: AcpPermissionDecision) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  abortListener: () => void;
}

interface PendingReverseInteraction {
  interactionId: string;
  kind: "elicitation" | "extension";
  serverId: string;
  sessionKey?: string;
  turnId?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  abortListener: () => void;
}

export type RuntimeCompatCallbacks = Pick<
  AcpRuntimeOptions,
  | "onRawMessage"
  | "onSessionUpdate"
  | "onElicitationRequest"
  | "onElicitationComplete"
  | "onExtensionRequest"
  | "onExtensionNotification"
  | "onAuthMetadata"
>;

export interface RuntimeFactoryInput {
  serverId: string;
  server: ServerConfig;
  options: PluginOptions;
  directory: string;
  onPermissionRequest: (
    request: AcpPermissionRequest,
    context: { signal: AbortSignal },
  ) => Promise<AcpPermissionDecision>;
  compatCallbacks: RuntimeCompatCallbacks;
}

export interface RuntimeHostOptions {
  emit: (event: RuntimeWorkerEvent) => void;
  runtimeFactory?: (
    input: RuntimeFactoryInput,
  ) => AcpRuntime | Promise<AcpRuntime>;
  now?: () => number;
}

export class RuntimeHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RuntimeHostError";
  }
}

export class RuntimeHost {
  readonly #emit: (event: RuntimeWorkerEvent) => void;
  readonly #runtimeFactory?: RuntimeHostOptions["runtimeFactory"];
  readonly #now: () => number;
  readonly #queue = new KeyedQueue();
  readonly #runtimes = new Map<string, RuntimeEntry>();
  readonly #turns = new Map<string, TurnRecord>();
  readonly #turnByRequest = new Map<string, string>();
  readonly #turnByBackendSession = new Map<string, string>();
  readonly #turnByToolCall = new Map<string, string>();
  readonly #sessionByBackend = new Map<
    string,
    { serverId: string; sessionKey: string }
  >();
  readonly #interactions = new Map<string, PendingInteraction>();
  readonly #reverseInteractions = new Map<string, PendingReverseInteraction>();
  readonly #turnTasks = new Set<Promise<void>>();
  #configuration?: ConfigureParams;
  #configurationFingerprint?: string;
  #idleTimer?: NodeJS.Timeout;
  #disposing = false;
  #disposePromise?: Promise<void>;

  constructor(options: RuntimeHostOptions) {
    this.#emit = options.emit;
    this.#runtimeFactory = options.runtimeFactory;
    this.#now = options.now ?? Date.now;
  }

  get capabilities(): WorkerCapabilityReport {
    return structuredClone(
      HAS_ACPX_COMPAT_HOOKS
        ? PATCHED_ACPX_FEATURE_SUPPORT
        : STOCK_ACPX_FEATURE_SUPPORT,
    );
  }

  async configure(params: ConfigureParams): Promise<void> {
    this.#assertAvailable();
    const normalised: ConfigureParams = {
      ...params,
      directory: resolve(params.directory),
      options: {
        ...params.options,
        stateDir: expandHome(params.options.stateDir),
      },
    };
    const fingerprint = objectFingerprint(normalised);
    if (this.#configuration !== undefined) {
      if (this.#configurationFingerprint !== fingerprint) {
        throw new RuntimeHostError(
          "CONFIGURATION_CONFLICT",
          "Worker is already configured with different settings",
        );
      }
      return;
    }
    this.#configuration = normalised;
    this.#configurationFingerprint = fingerprint;
    await mkdir(normalised.options.stateDir, { recursive: true, mode: 0o700 });
    for (const [serverId, server] of Object.entries(
      normalised.options.servers,
    )) {
      if (!server.enabled) continue;
      this.#runtimes.set(
        serverId,
        await this.#createRuntime(
          serverId,
          server,
          normalised.options,
          normalised.directory,
        ),
      );
      this.#emitRuntimeDiagnostics(serverId);
    }
    this.#startIdleTimer(normalised.options.idleTimeoutMs);
  }

  async catalogue(params: CatalogueParams): Promise<CatalogueResult> {
    this.#requireConfigured();
    const entry = this.#requireRuntime(params.serverId);
    const sessionKey = catalogueSessionKey(params.serverId, params.cwd);
    return await this.#queue.run(
      this.#queueKey(params.serverId, sessionKey),
      async () => {
        const handleEntry = await this.#ensureCatalogueHandle(
          entry,
          sessionKey,
          params.cwd,
        );
        try {
          const status =
            (await entry.runtime.getStatus?.({
              handle: handleEntry.handle,
            })) ?? {};
          const runtimeCapabilities = (await entry.runtime.getCapabilities?.({
            handle: handleEntry.handle,
          })) ?? { controls: [] };
          return extractCatalogue(
            params,
            status,
            runtimeCapabilities,
            this.capabilities,
          );
        } finally {
          await this.#closeCatalogueHandle(entry, sessionKey, handleEntry);
        }
      },
    );
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    await Promise.resolve();
    this.#requireConfigured();
    this.#assertAvailable();
    const fingerprint = objectFingerprint(params);
    const existing = this.#turns.get(params.turnId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new RuntimeHostError(
          "TURN_ID_CONFLICT",
          `Turn id ${params.turnId} was already used with different parameters`,
        );
      }
      existing.lastUsedAt = this.#now();
      return { ok: true, state: "existing" };
    }

    this.#requireRuntime(params.serverId);
    const requestKey = this.#requestKey(params);
    const previousTurnId = this.#turnByRequest.get(requestKey);
    if (previousTurnId !== undefined) {
      throw new RuntimeHostError(
        "REQUEST_ID_CONFLICT",
        `Request ${params.requestId} is already bound to turn ${previousTurnId}`,
      );
    }

    const record: TurnRecord = {
      params,
      fingerprint,
      requestKey,
      state: "queued",
      index: 0,
      abortController: new AbortController(),
      lastUsedAt: this.#now(),
      toolCallKeys: new Set(),
    };
    this.#turns.set(params.turnId, record);
    this.#turnByRequest.set(requestKey, params.turnId);
    const task = this.#queue
      .run(
        this.#queueKey(params.serverId, params.sessionKey),
        async () => await this.#runTurn(record),
        record.abortController.signal,
      )
      .catch((error: unknown) => this.#finishTurnFromError(record, error))
      .finally(() => {
        this.#turnTasks.delete(task);
      });
    record.task = task;
    this.#turnTasks.add(task);
    return { ok: true, state: "started" };
  }

  async cancelTurn(
    turnId: string,
    reason = "cancelled by OpenCode",
  ): Promise<TurnCancelResult> {
    const record = this.#turns.get(turnId);
    if (record === undefined) return { ok: true, state: "not_found" };
    if (record.state === "terminal")
      return { ok: true, state: "already_terminal" };
    record.abortController.abort(new Error(reason));
    this.#cancelInteractionsForTurn(turnId);
    await record.turn?.cancel({ reason }).catch(() => undefined);
    return { ok: true, state: "cancelled" };
  }

  respondInteraction(params: InteractionResponseParams): void {
    const pending = this.#interactions.get(params.interactionId);
    if (pending === undefined) {
      throw new RuntimeHostError(
        "INTERACTION_NOT_FOUND",
        "Unknown or expired interaction",
      );
    }
    const decision = this.#validatePermissionSelection(pending, params);
    this.#settleInteraction(pending, decision);
  }

  respondElicitation(params: ElicitationResponseParams): void {
    const pending = this.#requireReverseInteraction(
      params.interactionId,
      "elicitation",
    );
    this.#settleReverseInteraction(pending, params.response);
  }

  respondExtension(params: ExtensionResponseParams): void {
    const pending = this.#requireReverseInteraction(
      params.interactionId,
      "extension",
    );
    if (params.error !== undefined) {
      this.#rejectReverseInteraction(
        pending,
        new RuntimeHostError(
          params.error.code,
          params.error.message,
          params.error.details,
        ),
      );
      return;
    }
    this.#settleReverseInteraction(pending, params.result);
  }

  async setConfig(
    serverId: string,
    sessionKey: string,
    key: string,
    value: string,
  ): Promise<void> {
    this.#requireConfigured();
    const entry = this.#requireRuntime(serverId);
    const handleEntry = entry.handles.get(sessionKey);
    if (handleEntry === undefined)
      throw new RuntimeHostError("SESSION_NOT_FOUND", "Unknown ACP session");
    if (!entry.runtime.setConfigOption) {
      throw new RuntimeHostError(
        "UNSUPPORTED_CONTROL",
        "ACP runtime does not support config options",
      );
    }
    await this.#queue.run(this.#queueKey(serverId, sessionKey), async () => {
      await entry.runtime.setConfigOption?.({
        handle: handleEntry.handle,
        key,
        value,
      });
      handleEntry.lastUsedAt = this.#now();
    });
  }

  async setMode(
    serverId: string,
    sessionKey: string,
    mode: string,
  ): Promise<void> {
    this.#requireConfigured();
    const entry = this.#requireRuntime(serverId);
    const handleEntry = entry.handles.get(sessionKey);
    if (handleEntry === undefined)
      throw new RuntimeHostError("SESSION_NOT_FOUND", "Unknown ACP session");
    if (!entry.runtime.setMode) {
      throw new RuntimeHostError(
        "UNSUPPORTED_CONTROL",
        "ACP runtime does not support session modes",
      );
    }
    await this.#queue.run(this.#queueKey(serverId, sessionKey), async () => {
      await entry.runtime.setMode?.({ handle: handleEntry.handle, mode });
      handleEntry.lastUsedAt = this.#now();
    });
  }

  async closeSession(
    serverId: string,
    sessionKey: string,
    discardPersistentState = false,
  ): Promise<"closed" | "not_found"> {
    this.#requireConfigured();
    const entry = this.#requireRuntime(serverId);
    const handleEntry = entry.handles.get(sessionKey);
    if (handleEntry === undefined) return "not_found";
    const matchingTurns = [...this.#turns.values()].filter(
      (record) =>
        record.params.serverId === serverId &&
        record.params.sessionKey === sessionKey &&
        record.state !== "terminal",
    );
    await Promise.all(
      matchingTurns.map(
        async (record) => await this.cancelTurn(record.params.turnId),
      ),
    );
    await Promise.allSettled(
      matchingTurns.map(async (record) => await record.task),
    );
    await this.#queue.run(this.#queueKey(serverId, sessionKey), async () => {
      await entry.runtime.close({
        handle: handleEntry.handle,
        reason: "OpenCode session closed",
        discardPersistentState,
      });
      this.#forgetBackendSession(entry.serverId, handleEntry.handle);
      entry.handles.delete(sessionKey);
    });
    return "closed";
  }

  async sweepIdle(now = this.#now()): Promise<void> {
    const configuration = this.#configuration;
    if (configuration === undefined || this.#disposing) return;
    const cutoff = now - configuration.options.idleTimeoutMs;
    for (const entry of this.#runtimes.values()) {
      for (const [sessionKey, handleEntry] of entry.handles) {
        if (handleEntry.lastUsedAt > cutoff) continue;
        if (
          this.#queue.pending(this.#queueKey(entry.serverId, sessionKey)) !== 0
        )
          continue;
        await this.#queue.run(
          this.#queueKey(entry.serverId, sessionKey),
          async () =>
            await this.#closeIdleHandle(entry, sessionKey, handleEntry, cutoff),
        );
      }
    }
    for (const [turnId, record] of this.#turns) {
      if (record.state !== "terminal" || record.lastUsedAt > cutoff) continue;
      this.#turns.delete(turnId);
      if (this.#turnByRequest.get(record.requestKey) === turnId) {
        this.#turnByRequest.delete(record.requestKey);
      }
      for (const key of record.toolCallKeys) {
        if (this.#turnByToolCall.get(key) === turnId)
          this.#turnByToolCall.delete(key);
      }
    }
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    if (this.#disposing) return;
    this.#disposing = true;
    if (this.#idleTimer !== undefined) clearInterval(this.#idleTimer);
    for (const record of this.#turns.values()) {
      if (record.state === "terminal") continue;
      record.abortController.abort(new Error("worker disposed"));
      void record.turn
        ?.cancel({ reason: "worker disposed" })
        .catch(() => undefined);
    }
    for (const pending of [...this.#interactions.values()]) {
      this.#settleInteraction(pending, { outcome: "cancel" });
    }
    for (const pending of [...this.#reverseInteractions.values()]) {
      if (pending.kind === "elicitation") {
        this.#settleReverseInteraction(pending, { action: "cancel" });
      } else {
        this.#rejectReverseInteraction(
          pending,
          new RuntimeHostError("WORKER_DISPOSING", "Worker is disposing"),
        );
      }
    }
    await settleWithin([...this.#turnTasks], DISPOSE_GRACE_MS);
    const closeOperations: Promise<unknown>[] = [];
    for (const entry of this.#runtimes.values()) {
      for (const handleEntry of entry.handles.values()) {
        closeOperations.push(
          entry.runtime.close({
            handle: handleEntry.handle,
            reason: "worker disposed",
            discardPersistentState: false,
          }),
        );
      }
    }
    await settleWithin(closeOperations, DISPOSE_GRACE_MS);
    this.#interactions.clear();
    this.#reverseInteractions.clear();
    this.#sessionByBackend.clear();
    this.#turnByBackendSession.clear();
    this.#turnByToolCall.clear();
    this.#turnByRequest.clear();
    this.#turns.clear();
    this.#runtimes.clear();
  }

  async #runTurn(record: TurnRecord): Promise<void> {
    if (record.abortController.signal.aborted)
      throw record.abortController.signal.reason;
    const { params } = record;
    const entry = this.#requireRuntime(params.serverId);
    const handleEntry = await this.#ensureHandle(entry, params);
    const backendKey =
      handleEntry.handle.backendSessionId === undefined
        ? undefined
        : this.#backendSessionKey(
            params.serverId,
            handleEntry.handle.backendSessionId,
          );
    if (backendKey !== undefined)
      this.#turnByBackendSession.set(backendKey, params.turnId);
    record.state = "active";
    handleEntry.lastUsedAt = this.#now();
    const turn = entry.runtime.startTurn({
      handle: handleEntry.handle,
      text: params.text,
      mode: "prompt",
      requestId: params.requestId,
      signal: record.abortController.signal,
      ...(params.attachments === undefined
        ? {}
        : { attachments: params.attachments }),
    });
    record.turn = turn;
    try {
      for await (const event of turn.events) {
        if (event.type === "tool_call" && event.toolCallId !== undefined) {
          const key = this.#toolCallKey(params.serverId, event.toolCallId);
          this.#turnByToolCall.set(key, params.turnId);
          record.toolCallKeys.add(key);
        }
        this.#emit({
          type: "turn.event",
          turnId: params.turnId,
          index: record.index++,
          event,
        });
      }
      this.#finishTurn(record, await turn.result);
    } finally {
      handleEntry.lastUsedAt = this.#now();
      if (
        backendKey !== undefined &&
        this.#turnByBackendSession.get(backendKey) === params.turnId
      ) {
        this.#turnByBackendSession.delete(backendKey);
      }
      this.#cancelInteractionsForTurn(params.turnId);
    }
  }

  #finishTurnFromError(record: TurnRecord, error: unknown): void {
    if (record.state === "terminal") return;
    if (record.abortController.signal.aborted) {
      this.#finishTurn(record, {
        status: "cancelled",
        stopReason: "cancelled",
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RuntimeHostError ? error.code : undefined;
    this.#finishTurn(record, {
      status: "failed",
      error: { message, ...(code === undefined ? {} : { code }) },
    });
  }

  #finishTurn(record: TurnRecord, result: AcpRuntimeTurnResult): void {
    if (record.state === "terminal") return;
    record.state = "terminal";
    record.result = result;
    record.lastUsedAt = this.#now();
    this.#emit({
      type: "turn.result",
      turnId: record.params.turnId,
      index: record.index++,
      result,
    });
  }

  async #createRuntime(
    serverId: string,
    server: ServerConfig,
    options: PluginOptions,
    directory: string,
  ): Promise<RuntimeEntry> {
    const onPermissionRequest = async (
      request: AcpPermissionRequest,
      context: { signal: AbortSignal },
    ): Promise<AcpPermissionDecision> =>
      await this.#requestPermission(serverId, request, context.signal);
    const compatCallbacks = this.#compatCallbacks(serverId);
    const runtime = this.#runtimeFactory
      ? await this.#runtimeFactory({
          serverId,
          server,
          options,
          directory,
          onPermissionRequest,
          compatCallbacks,
        })
      : await this.#createStockRuntime(
          serverId,
          server,
          options,
          directory,
          onPermissionRequest,
          compatCallbacks,
        );
    return { serverId, server, runtime, handles: new Map() };
  }

  #compatCallbacks(serverId: string): RuntimeCompatCallbacks {
    return {
      onRawMessage: (direction, message) => {
        this.#emit({
          type: "protocol.raw",
          serverId,
          ...this.#correlation(serverId, message),
          direction:
            direction === "outbound" ? "client-to-agent" : "agent-to-client",
          message,
        });
      },
      onSessionUpdate: (notification) => {
        this.#emit({
          type: "session.update",
          serverId,
          ...this.#correlation(serverId, notification),
          notification,
        });
      },
      onElicitationRequest: async (request, context) =>
        (await this.#requestReverseInteraction(
          "elicitation",
          serverId,
          request,
          context.signal,
        )) as CreateElicitationResponse,
      onElicitationComplete: (notification) => {
        this.#emit({
          type: "elicitation.complete",
          serverId,
          ...this.#correlation(serverId, notification),
          notification,
        });
      },
      onExtensionRequest: async (method, params, context) =>
        await this.#requestReverseInteraction(
          "extension",
          serverId,
          { method, params },
          context.signal,
        ),
      onExtensionNotification: (method, params) => {
        this.#emit({
          type: "extension.notification",
          serverId,
          ...this.#correlation(serverId, params),
          method,
          params,
        });
      },
      onAuthMetadata: (metadata) => {
        this.#emit({
          type: "auth.metadata",
          serverId,
          ...this.#correlation(serverId, metadata),
          metadata,
        });
      },
    };
  }

  async #createStockRuntime(
    serverId: string,
    server: ServerConfig,
    options: PluginOptions,
    directory: string,
    onPermissionRequest: RuntimeFactoryInput["onPermissionRequest"],
    compatCallbacks: RuntimeCompatCallbacks,
  ): Promise<AcpRuntime> {
    if (!HAS_ACPX_COMPAT_HOOKS) {
      throw new RuntimeHostError(
        "ACPX_COMPAT_HOOKS_REQUIRED",
        "The pinned Acpx compatibility hooks are not installed",
      );
    }
    const stateDir = join(options.stateDir, "servers", serverId);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const command = resolveRuntimeCommand(server);
    return createAcpRuntime({
      cwd: directory,
      sessionStore: createRuntimeStore({ stateDir }),
      agentRegistry: createAgentRegistry({
        overrides: { [serverId]: [command.command, ...command.args] },
      }),
      permissionMode: "deny-all",
      nonInteractivePermissions: options.permissions.fallback,
      mcpServers: server.mcpServers,
      verbose: options.trace,
      onPermissionRequest,
      ...compatCallbacks,
    });
  }

  async #ensureCatalogueHandle(
    entry: RuntimeEntry,
    sessionKey: string,
    cwd: string,
  ): Promise<HandleEntry> {
    const existing = entry.handles.get(sessionKey);
    if (existing !== undefined) return existing;
    const handle = await entry.runtime.ensureSession({
      sessionKey,
      agent: entry.serverId,
      mode: "persistent",
      cwd,
    });
    const handleEntry = { handle, lastUsedAt: this.#now() };
    entry.handles.set(sessionKey, handleEntry);
    this.#rememberBackendSession(entry.serverId, sessionKey, handle);
    return handleEntry;
  }

  async #closeCatalogueHandle(
    entry: RuntimeEntry,
    sessionKey: string,
    handleEntry: HandleEntry,
  ): Promise<void> {
    try {
      await entry.runtime.close({
        handle: handleEntry.handle,
        reason: "OpenCode catalogue probe completed",
        discardPersistentState: true,
      });
    } catch (error) {
      if (!isUnsupportedBackendClose(error)) throw error;
      this.#emitDiagnostic({
        level: "info",
        code: "CATALOGUE_SESSION_CLOSE_UNSUPPORTED",
        message:
          "The ACP agent does not advertise session/close; its catalogue probe process was disconnected without deleting the remote session.",
        serverId: entry.serverId,
        details: { sessionKey },
      });
    } finally {
      this.#forgetBackendSession(entry.serverId, handleEntry.handle);
      entry.handles.delete(sessionKey);
    }
  }

  async #ensureHandle(
    entry: RuntimeEntry,
    params: TurnStartParams,
  ): Promise<HandleEntry> {
    const existing = entry.handles.get(params.sessionKey);
    if (existing !== undefined) return existing;
    const environment = this.#sessionEnvironment(entry.server);
    const handle = await entry.runtime.ensureSession({
      sessionKey: params.sessionKey,
      agent: params.serverId,
      mode: "persistent",
      cwd: params.cwd,
      sessionOptions: {
        ...(params.modelId === undefined ? {} : { model: params.modelId }),
        ...(entry.server.allowedTools === undefined
          ? {}
          : { allowedTools: entry.server.allowedTools }),
        ...(entry.server.maxTurns === undefined
          ? {}
          : { maxTurns: entry.server.maxTurns }),
        ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
        ...this.#systemPromptOptions(entry.server),
      },
    });
    const handleEntry = { handle, lastUsedAt: this.#now() };
    entry.handles.set(params.sessionKey, handleEntry);
    this.#rememberBackendSession(entry.serverId, params.sessionKey, handle);
    if (entry.server.mode !== undefined)
      await entry.runtime.setMode?.({ handle, mode: entry.server.mode });
    for (const [key, value] of Object.entries(entry.server.config)) {
      await entry.runtime.setConfigOption?.({
        handle,
        key,
        value: String(value),
      });
    }
    return handleEntry;
  }

  #sessionEnvironment(server: ServerConfig): Record<string, string> {
    const environment = { ...server.env };
    for (const name of server.forwardEnv) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    return environment;
  }

  #systemPromptOptions(server: ServerConfig): Partial<SessionAgentOptions> {
    if (server.nativeSystemPrompt !== undefined)
      return { systemPrompt: server.nativeSystemPrompt };
    if (server.appendSystemPrompt !== undefined) {
      return { systemPrompt: { append: server.appendSystemPrompt } };
    }
    return {};
  }

  async #requestPermission(
    serverId: string,
    request: AcpPermissionRequest,
    signal: AbortSignal,
  ): Promise<AcpPermissionDecision> {
    const backendKey = this.#backendSessionKey(serverId, request.sessionId);
    const turnId = this.#turnByBackendSession.get(backendKey);
    if (turnId === undefined) return { outcome: "cancel" };
    const record = this.#turns.get(turnId);
    if (record?.state !== "active") return { outcome: "cancel" };
    const interactionId = randomUUID();
    const timeoutMs =
      this.#configuration?.options.interactionTimeoutMs ??
      DEFAULT_INTERACTION_TIMEOUT_MS;
    const expiresAt = this.#now() + timeoutMs;
    return await new Promise<AcpPermissionDecision>((resolveDecision) => {
      const abortListener = (): void => {
        const pending = this.#interactions.get(interactionId);
        if (pending !== undefined)
          this.#settleInteraction(pending, { outcome: "cancel" });
      };
      const timer = setTimeout(abortListener, timeoutMs);
      timer.unref();
      const pending: PendingInteraction = {
        interactionId,
        turnId,
        sessionKey: record.params.sessionKey,
        expiresAt,
        request,
        resolve: resolveDecision,
        timer,
        signal,
        abortListener,
      };
      this.#interactions.set(interactionId, pending);
      signal.addEventListener("abort", abortListener, { once: true });
      const event: PermissionInteraction = {
        type: "interaction.permission",
        turnId,
        index: record.index++,
        interactionId,
        serverId: record.params.serverId,
        sessionKey: record.params.sessionKey,
        expiresAt,
        request: request.raw,
        ...(request.inferredKind === undefined
          ? {}
          : { inferredKind: request.inferredKind }),
      };
      this.#emit(event);
    });
  }

  async #requestReverseInteraction(
    kind: "elicitation" | "extension",
    serverId: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const interactionId = randomUUID();
    const timeoutMs =
      this.#configuration?.options.interactionTimeoutMs ??
      DEFAULT_INTERACTION_TIMEOUT_MS;
    const expiresAt = this.#now() + timeoutMs;
    const correlation = this.#correlation(serverId, payload);
    return await new Promise<unknown>((resolveValue, rejectValue) => {
      const abortListener = (): void => {
        const pending = this.#reverseInteractions.get(interactionId);
        if (pending === undefined) return;
        if (pending.kind === "elicitation") {
          this.#settleReverseInteraction(pending, { action: "cancel" });
        } else {
          this.#rejectReverseInteraction(
            pending,
            new RuntimeHostError(
              signal.aborted ? "INTERACTION_CANCELLED" : "INTERACTION_TIMEOUT",
              signal.aborted
                ? "Extension request was cancelled"
                : "Extension request timed out",
            ),
          );
        }
      };
      const timer = setTimeout(abortListener, timeoutMs);
      timer.unref();
      const pending: PendingReverseInteraction = {
        interactionId,
        kind,
        serverId,
        ...correlation,
        resolve: resolveValue,
        reject: rejectValue,
        timer,
        signal,
        abortListener,
      };
      this.#reverseInteractions.set(interactionId, pending);
      signal.addEventListener("abort", abortListener, { once: true });
      if (kind === "elicitation") {
        this.#emit({
          type: "interaction.elicitation",
          interactionId,
          serverId,
          ...correlation,
          expiresAt,
          request: payload,
        });
      } else {
        const extension = isRecord(payload) ? payload : {};
        this.#emit({
          type: "interaction.extension",
          interactionId,
          serverId,
          ...correlation,
          expiresAt,
          method:
            typeof extension.method === "string" ? extension.method : "unknown",
          params: extension.params,
        });
      }
    });
  }

  #requireReverseInteraction(
    interactionId: string,
    kind: PendingReverseInteraction["kind"],
  ): PendingReverseInteraction {
    const pending = this.#reverseInteractions.get(interactionId);
    if (pending === undefined) {
      throw new RuntimeHostError(
        "INTERACTION_NOT_FOUND",
        "Unknown or expired interaction",
      );
    }
    if (pending.kind !== kind) {
      throw new RuntimeHostError(
        "INTERACTION_KIND_MISMATCH",
        `Interaction ${interactionId} is ${pending.kind}, not ${kind}`,
      );
    }
    return pending;
  }

  #settleReverseInteraction(
    pending: PendingReverseInteraction,
    value: unknown,
  ): void {
    if (!this.#reverseInteractions.delete(pending.interactionId)) return;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abortListener);
    pending.resolve(value);
  }

  #rejectReverseInteraction(
    pending: PendingReverseInteraction,
    error: Error,
  ): void {
    if (!this.#reverseInteractions.delete(pending.interactionId)) return;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abortListener);
    pending.reject(error);
  }

  #validatePermissionSelection(
    pending: PendingInteraction,
    response: InteractionResponseParams,
  ): AcpPermissionDecision {
    if (response.decision.outcome === "cancel") {
      if (response.optionId !== undefined) {
        throw new RuntimeHostError(
          "INVALID_PERMISSION_SELECTION",
          "A cancelled permission response must not include optionId",
        );
      }
      return response.decision;
    }
    const options = pending.request.raw.options;
    if (response.optionId === undefined) {
      const exact = options.filter(
        (option) => option.kind === response.decision.outcome,
      );
      if (exact.length === 0) {
        throw new RuntimeHostError(
          "PERMISSION_OPTION_UNAVAILABLE",
          `The agent did not offer a ${response.decision.outcome} option`,
        );
      }
      if (exact.length !== 1) {
        throw new RuntimeHostError(
          "AMBIGUOUS_PERMISSION_OPTION",
          `The agent offered more than one ${response.decision.outcome} option; optionId is required`,
        );
      }
      return response.decision;
    }
    const selected = options.find(
      (option) => option.optionId === response.optionId,
    );
    if (selected === undefined) {
      throw new RuntimeHostError(
        "PERMISSION_OPTION_UNAVAILABLE",
        `The agent did not offer permission option ${response.optionId}`,
      );
    }
    const selectedKind: string = selected.kind;
    if (!isStandardPermissionKind(selectedKind)) {
      this.#emitDiagnostic({
        level: "error",
        code: "ACPX_RUNTIME_CUSTOM_PERMISSION_OPTION_UNAVAILABLE",
        message: `Stock Acpx cannot select custom permission option kind ${selectedKind}`,
        details: { optionId: selected.optionId, kind: selectedKind },
      });
      throw new RuntimeHostError(
        "UNSUPPORTED_PERMISSION_OPTION",
        `Stock Acpx cannot select custom permission option kind ${selectedKind}`,
      );
    }
    if (selected.kind !== response.decision.outcome) {
      throw new RuntimeHostError(
        "INVALID_PERMISSION_SELECTION",
        `Permission option ${response.optionId} has kind ${selected.kind}, not ${response.decision.outcome}`,
      );
    }
    if (
      options.filter((option) => option.kind === selected.kind).length !== 1
    ) {
      throw new RuntimeHostError(
        "AMBIGUOUS_PERMISSION_OPTION",
        "Stock Acpx cannot distinguish duplicate permission options with the same kind",
      );
    }
    return { outcome: selected.kind };
  }

  #settleInteraction(
    pending: PendingInteraction,
    decision: AcpPermissionDecision,
  ): void {
    if (!this.#interactions.delete(pending.interactionId)) return;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abortListener);
    pending.resolve(decision);
  }

  #cancelInteractionsForTurn(turnId: string): void {
    for (const pending of [...this.#interactions.values()]) {
      if (pending.turnId === turnId)
        this.#settleInteraction(pending, { outcome: "cancel" });
    }
    for (const pending of [...this.#reverseInteractions.values()]) {
      if (pending.turnId !== turnId) continue;
      if (pending.kind === "elicitation") {
        this.#settleReverseInteraction(pending, { action: "cancel" });
      } else {
        this.#rejectReverseInteraction(
          pending,
          new RuntimeHostError(
            "INTERACTION_CANCELLED",
            "Extension request was cancelled with its turn",
          ),
        );
      }
    }
  }

  #emitRuntimeDiagnostics(serverId: string): void {
    const capabilities = this.capabilities;
    for (const feature of [
      "extensions",
      "elicitation",
      "rawProtocolEvents",
      "clientCapabilityControl",
    ] as const) {
      const support = capabilities[feature];
      if (support.supported) continue;
      this.#emitDiagnostic({
        level: "warning",
        message: support.message ?? `${feature} is unavailable`,
        serverId,
        ...(support.code === undefined ? {} : { code: support.code }),
      });
    }
  }

  #emitDiagnostic(diagnostic: Omit<WorkerDiagnostic, "type">): void {
    this.#emit({ type: "diagnostic", ...diagnostic });
  }

  #startIdleTimer(idleTimeoutMs: number): void {
    const intervalMs = Math.min(
      MAXIMUM_IDLE_SWEEP_INTERVAL_MS,
      Math.max(MINIMUM_IDLE_SWEEP_INTERVAL_MS, Math.floor(idleTimeoutMs / 2)),
    );
    this.#idleTimer = setInterval(() => {
      void this.sweepIdle().catch((error: unknown) => {
        this.#emitDiagnostic({
          level: "warning",
          code: "IDLE_CLEANUP_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    this.#idleTimer.unref();
  }

  async #closeIdleHandle(
    entry: RuntimeEntry,
    sessionKey: string,
    handleEntry: HandleEntry,
    cutoff: number,
  ): Promise<void> {
    if (
      entry.handles.get(sessionKey) !== handleEntry ||
      handleEntry.lastUsedAt > cutoff
    ) {
      return;
    }
    try {
      await entry.runtime.close({
        handle: handleEntry.handle,
        reason: "worker idle timeout",
        discardPersistentState: false,
      });
      this.#forgetBackendSession(entry.serverId, handleEntry.handle);
      entry.handles.delete(sessionKey);
    } catch (error) {
      this.#emitDiagnostic({
        level: "warning",
        code: "IDLE_SESSION_CLOSE_FAILED",
        message: error instanceof Error ? error.message : String(error),
        serverId: entry.serverId,
        details: { sessionKey },
      });
    }
  }

  #rememberBackendSession(
    serverId: string,
    sessionKey: string,
    handle: AcpRuntimeHandle,
  ): void {
    if (handle.backendSessionId === undefined) return;
    this.#sessionByBackend.set(
      this.#backendSessionKey(serverId, handle.backendSessionId),
      { serverId, sessionKey },
    );
  }

  #forgetBackendSession(serverId: string, handle: AcpRuntimeHandle): void {
    if (handle.backendSessionId === undefined) return;
    this.#sessionByBackend.delete(
      this.#backendSessionKey(serverId, handle.backendSessionId),
    );
  }

  #correlation(
    serverId: string,
    payload: unknown,
  ): { sessionKey?: string; turnId?: string } {
    const backendSessionId = findSessionId(payload);
    if (backendSessionId === undefined) {
      const toolCallId = findToolCallId(payload);
      if (toolCallId === undefined) return {};
      const turnId = this.#turnByToolCall.get(
        this.#toolCallKey(serverId, toolCallId),
      );
      if (turnId === undefined) return {};
      const record = this.#turns.get(turnId);
      return record === undefined
        ? { turnId }
        : { sessionKey: record.params.sessionKey, turnId };
    }
    const backendKey = this.#backendSessionKey(serverId, backendSessionId);
    const turnId = this.#turnByBackendSession.get(backendKey);
    if (turnId !== undefined) {
      const record = this.#turns.get(turnId);
      return record === undefined
        ? { turnId }
        : { sessionKey: record.params.sessionKey, turnId };
    }
    const session = this.#sessionByBackend.get(backendKey);
    return session === undefined ? {} : { sessionKey: session.sessionKey };
  }

  #queueKey(serverId: string, sessionKey: string): string {
    return `${serverId}\u0000${sessionKey}`;
  }

  #backendSessionKey(serverId: string, backendSessionId: string): string {
    return `${serverId}\u0000${backendSessionId}`;
  }

  #toolCallKey(serverId: string, toolCallId: string): string {
    return `${serverId}\u0000${toolCallId}`;
  }

  #requestKey(params: TurnStartParams): string {
    return `${params.serverId}\u0000${params.sessionKey}\u0000${params.requestId}`;
  }

  #requireRuntime(serverId: string): RuntimeEntry {
    const runtime = this.#runtimes.get(serverId);
    if (runtime === undefined) {
      throw new RuntimeHostError(
        "SERVER_NOT_FOUND",
        `Unknown or disabled ACP server: ${serverId}`,
      );
    }
    return runtime;
  }

  #requireConfigured(): void {
    if (this.#configuration === undefined) {
      throw new RuntimeHostError(
        "NOT_CONFIGURED",
        "Worker must be configured before use",
      );
    }
  }

  #assertAvailable(): void {
    if (this.#disposing)
      throw new RuntimeHostError("WORKER_DISPOSING", "Worker is disposing");
  }
}

function catalogueSessionKey(serverId: string, cwd: string): string {
  const suffix = createHash("sha256")
    .update(resolve(cwd))
    .digest("hex")
    .slice(0, 24);
  return `catalogue:${serverId}:${suffix}`;
}

function isUnsupportedBackendClose(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ACP_BACKEND_UNSUPPORTED_CONTROL"
  );
}

function extractCatalogue(
  params: CatalogueParams,
  status: AcpRuntimeStatus,
  runtimeCapabilities: CatalogueResult["runtimeCapabilities"],
  featureSupport: WorkerCapabilityReport,
): CatalogueResult {
  const details = isRecord(status.details) ? status.details : undefined;
  const configOptions = Array.isArray(details?.configOptions)
    ? details.configOptions
    : [];
  const names = modelNamesFromConfigOptions(configOptions);
  const modelIds = new Set(status.models?.availableModelIds ?? []);
  for (const id of names.keys()) modelIds.add(id);
  const models: CatalogueModel[] = [...modelIds].map((id) => {
    const name = names.get(id);
    return name === undefined ? { id } : { id, name };
  });
  return {
    serverId: params.serverId,
    cwd: resolve(params.cwd),
    ...(status.models?.currentModelId === undefined
      ? {}
      : { currentModelId: status.models.currentModelId }),
    models,
    configOptions: structuredClone(configOptions),
    availableCommands: structuredClone(status.availableCommands ?? []),
    runtimeCapabilities,
    featureSupport,
    ...(details === undefined
      ? {}
      : { statusDetails: structuredClone(details) }),
  };
}

function modelNamesFromConfigOptions(
  configOptions: unknown[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const option of configOptions) {
    if (
      !isRecord(option) ||
      (option.category !== "model" && option.id !== "model")
    )
      continue;
    const choices = Array.isArray(option.options) ? option.options : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const id = stringField(choice, ["value", "id", "modelId"]);
      if (id === undefined) continue;
      const name = stringField(choice, ["name", "label", "title"]);
      if (name !== undefined) names.set(id, name);
      else if (!names.has(id)) names.set(id, id);
    }
  }
  return names;
}

function stringField(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function findSessionId(value: unknown, depth = 0): string | undefined {
  if (!isRecord(value) || depth > 3) return undefined;
  const direct = stringField(value, ["sessionId", "session_id"]);
  if (direct !== undefined) return direct;
  for (const key of ["params", "request", "notification", "message"]) {
    const nested = findSessionId(value[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findToolCallId(value: unknown, depth = 0): string | undefined {
  if (!isRecord(value) || depth > 3) return undefined;
  const direct = stringField(value, [
    "toolCallId",
    "tool_call_id",
    "callId",
    "call_id",
  ]);
  if (direct !== undefined) return direct;
  for (const key of [
    "params",
    "request",
    "notification",
    "message",
    "update",
  ]) {
    const nested = findToolCallId(value[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function isStandardPermissionKind(
  kind: string,
): kind is Exclude<AcpPermissionDecision["outcome"], "cancel"> {
  return [
    "allow_once",
    "allow_always",
    "reject_once",
    "reject_always",
  ].includes(kind);
}

function objectFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function settleWithin(
  promises: Iterable<Promise<unknown>>,
  timeoutMs: number,
): Promise<void> {
  const pending = Promise.allSettled([...promises]).then(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, timeoutMs);
    timer.unref();
  });
  await Promise.race([pending, timeout]);
  if (timer !== undefined) clearTimeout(timer);
}
