import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AcpPermissionDecision } from "acpx/runtime";

import type { PluginOptions } from "../config.js";
import { DEFAULT_MAX_FRAME_BYTES, RPC_PROTOCOL_VERSION } from "../constants.js";
import type {
  CatalogueParams,
  CatalogueResult,
  ConfigureParams,
  ConfigureResult,
  InteractionResponseParams,
  RuntimeWorkerEvent,
  TurnCancelResult,
  TurnStartParams,
  WorkerMethod,
  WorkerMethodParams,
  WorkerMethodResults,
  WorkerReady,
} from "./messages.js";
import {
  BoundedNdjsonDecoder,
  encodeBoundedFrame,
  eventEnvelopeSchema,
  parseMethodResult,
  parseRuntimeWorkerEvent,
  responseEnvelopeSchema,
  type RequestEnvelope,
} from "./protocol.js";
import { TurnChannel } from "./turn-channel.js";

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_500;

interface PendingRequest {
  method: WorkerMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface WorkerClientOptions {
  workerPath: string;
  pluginOptions: PluginOptions;
  nodeCommand?: string;
  maxFrameBytes?: number;
  readyTimeoutMs?: number;
  disposeTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}

export class WorkerRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkerRequestError";
  }
}

export class WorkerClient {
  readonly #token = randomBytes(32).toString("hex");
  readonly #pending = new Map<string, PendingRequest>();
  readonly #turns = new Map<string, TurnChannel>();
  readonly #turnFingerprints = new Map<string, string>();
  readonly #listeners = new Set<(event: RuntimeWorkerEvent) => void>();
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder: BoundedNdjsonDecoder;
  readonly #maxFrameBytes: number;
  readonly #disposeTimeoutMs: number;
  readonly #onDiagnostic: (message: string) => void;
  readonly #readyPromise: Promise<WorkerReady>;
  readonly #exitPromise: Promise<void>;
  #resolveReady!: (event: WorkerReady) => void;
  #rejectReady!: (error: Error) => void;
  #resolveExit!: () => void;
  #ready?: WorkerReady;
  #readyTimer?: NodeJS.Timeout;
  #closed = false;
  #disposing = false;
  #configured?: Promise<ConfigureResult>;
  #configurationFingerprint?: string;

  constructor(options: WorkerClientOptions) {
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#disposeTimeoutMs =
      options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#decoder = new BoundedNdjsonDecoder(this.#maxFrameBytes);
    this.#readyPromise = new Promise<WorkerReady>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    void this.#readyPromise.catch(() => undefined);
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#child = spawn(options.nodeCommand ?? "node", [options.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.#workerEnvironment(options.pluginOptions),
      windowsHide: true,
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#handleChunk(chunk));
    this.#child.stdout.once("end", () => {
      try {
        this.#decoder.end();
      } catch (error) {
        this.#fail(asError(error));
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      const message = chunk.trimEnd();
      if (message !== "") this.#onDiagnostic(message);
    });
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) => {
      this.#resolveExit();
      if (this.#disposing) return;
      this.#fail(
        new Error(`ACP worker exited unexpectedly (${signal ?? String(code)})`),
      );
    });
    const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.#readyTimer = setTimeout(() => {
      this.#fail(
        new Error(
          `ACP worker did not become ready within ${String(readyTimeoutMs)} ms`,
        ),
      );
    }, readyTimeoutMs);
    this.#readyTimer.unref();
  }

  configure(params: ConfigureParams): Promise<ConfigureResult> {
    const fingerprint = stableJson(params);
    if (
      this.#configurationFingerprint !== undefined &&
      this.#configurationFingerprint !== fingerprint
    ) {
      return Promise.reject(
        new WorkerRequestError(
          "CONFIGURATION_CONFLICT",
          "Worker client is already configured with different settings",
        ),
      );
    }
    this.#configurationFingerprint = fingerprint;
    this.#configured ??= this.request("configure", params);
    return this.#configured;
  }

  catalogue(params: CatalogueParams): Promise<CatalogueResult> {
    return this.request("catalogue", params);
  }

  async startTurn(params: TurnStartParams): Promise<TurnChannel> {
    const fingerprint = stableJson(params);
    const existing = this.#turns.get(params.turnId);
    if (existing !== undefined) {
      if (this.#turnFingerprints.get(params.turnId) !== fingerprint) {
        throw new WorkerRequestError(
          "TURN_ID_CONFLICT",
          `Turn id ${params.turnId} was already used with different parameters`,
        );
      }
      return existing;
    }
    const channel = new TurnChannel(params.turnId);
    this.#turns.set(params.turnId, channel);
    this.#turnFingerprints.set(params.turnId, fingerprint);
    try {
      await this.request("turn.start", params);
      return channel;
    } catch (error) {
      this.#turns.delete(params.turnId);
      this.#turnFingerprints.delete(params.turnId);
      throw error;
    }
  }

  getTurn(turnId: string): TurnChannel | undefined {
    return this.#turns.get(turnId);
  }

  cancelTurn(turnId: string, reason?: string): Promise<TurnCancelResult> {
    return this.request(
      "turn.cancel",
      reason === undefined ? { turnId } : { turnId, reason },
    );
  }

  respondPermission(
    interactionId: string,
    decision: AcpPermissionDecision,
    optionId?: string,
  ): Promise<WorkerMethodResults["interaction.respond"]> {
    const params: InteractionResponseParams = {
      interactionId,
      decision,
      ...(optionId === undefined ? {} : { optionId }),
    };
    return this.request("interaction.respond", params);
  }

  respondElicitation(
    interactionId: string,
    response: unknown,
  ): Promise<WorkerMethodResults["interaction.elicitation.respond"]> {
    return this.request("interaction.elicitation.respond", {
      interactionId,
      response,
    });
  }

  respondExtension(
    params: WorkerMethodParams["interaction.extension.respond"],
  ): Promise<WorkerMethodResults["interaction.extension.respond"]> {
    return this.request("interaction.extension.respond", params);
  }

  setConfig(
    serverId: string,
    sessionKey: string,
    key: string,
    value: string,
  ): Promise<WorkerMethodResults["session.setConfig"]> {
    return this.request("session.setConfig", {
      serverId,
      sessionKey,
      key,
      value,
    });
  }

  setMode(
    serverId: string,
    sessionKey: string,
    mode: string,
  ): Promise<WorkerMethodResults["session.setMode"]> {
    return this.request("session.setMode", { serverId, sessionKey, mode });
  }

  closeSession(
    serverId: string,
    sessionKey: string,
    discardPersistentState = false,
  ): Promise<WorkerMethodResults["session.close"]> {
    return this.request("session.close", {
      serverId,
      sessionKey,
      discardPersistentState,
    });
  }

  subscribe(listener: (event: RuntimeWorkerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async request<Method extends WorkerMethod>(
    method: Method,
    params: WorkerMethodParams[Method],
  ): Promise<WorkerMethodResults[Method]> {
    if (this.#closed || this.#disposing)
      throw new Error("ACP worker is closed");
    await this.#readyPromise;
    const id = randomUUID();
    const envelope: RequestEnvelope = {
      kind: "request",
      version: RPC_PROTOCOL_VERSION,
      token: this.#token,
      id,
      method,
      params,
    };
    const result = new Promise<WorkerMethodResults[Method]>(
      (resolve, reject) => {
        this.#pending.set(id, {
          method,
          resolve: (value) => resolve(value as WorkerMethodResults[Method]),
          reject,
        });
      },
    );
    try {
      this.#child.stdin.write(
        encodeBoundedFrame(envelope, this.#maxFrameBytes),
      );
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return await result;
  }

  async dispose(): Promise<void> {
    if (this.#closed || this.#disposing) return;
    try {
      await this.#readyPromise;
      await this.request("dispose", {});
    } catch {
      // Disposal is best-effort after startup or protocol failure.
    }
    this.#disposing = true;
    this.#closed = true;
    if (this.#readyTimer !== undefined) clearTimeout(this.#readyTimer);
    this.#child.stdin.end();
    if (this.#child.exitCode === null) {
      const exited = await settlesWithin(
        this.#exitPromise,
        this.#disposeTimeoutMs,
      );
      if (!exited) this.#child.kill("SIGTERM");
      if (!exited)
        await settlesWithin(this.#exitPromise, this.#disposeTimeoutMs);
    }
    this.#rejectAll(new Error("ACP worker is closed"));
    this.#listeners.clear();
    this.#turns.clear();
    this.#turnFingerprints.clear();
  }

  #handleChunk(chunk: Buffer): void {
    if (this.#closed) return;
    try {
      for (const line of this.#decoder.push(chunk)) this.#handleLine(line);
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.#fail(new Error("ACP worker sent invalid JSON", { cause: error }));
      return;
    }
    const response = responseEnvelopeSchema.safeParse(value);
    if (response.success) {
      if (response.data.token !== this.#token) {
        this.#fail(new Error("ACP worker response token mismatch"));
        return;
      }
      if (this.#ready === undefined) {
        this.#fail(new Error("ACP worker sent a response before worker.ready"));
        return;
      }
      const pending = this.#pending.get(response.data.id);
      if (pending === undefined) {
        this.#fail(
          new Error(
            `ACP worker sent an unknown response id: ${response.data.id}`,
          ),
        );
        return;
      }
      this.#pending.delete(response.data.id);
      if (response.data.error !== undefined) {
        pending.reject(
          new WorkerRequestError(
            response.data.error.code,
            response.data.error.message,
            response.data.error.details,
          ),
        );
      } else {
        try {
          pending.resolve(
            parseMethodResult(pending.method, response.data.result),
          );
        } catch (error) {
          const failure = new Error(
            `ACP worker returned an invalid ${pending.method} result`,
            { cause: error },
          );
          pending.reject(failure);
          this.#fail(failure);
        }
      }
      return;
    }
    const event = eventEnvelopeSchema.safeParse(value);
    if (!event.success || event.data.token !== this.#token) {
      this.#fail(new Error("ACP worker sent an invalid envelope"));
      return;
    }
    let payload: RuntimeWorkerEvent;
    try {
      payload = parseRuntimeWorkerEvent(event.data.event);
    } catch (error) {
      this.#fail(
        new Error("ACP worker sent an invalid event", { cause: error }),
      );
      return;
    }
    if (payload.type === "worker.ready") {
      this.#handleReady(payload);
      return;
    }
    if (this.#ready === undefined) {
      this.#fail(new Error("ACP worker sent an event before worker.ready"));
      return;
    }
    if (
      payload.type === "turn.event" ||
      payload.type === "turn.result" ||
      payload.type === "interaction.permission"
    ) {
      const channel = this.#turns.get(payload.turnId);
      if (channel === undefined) {
        this.#fail(
          new Error(
            `ACP worker sent an event for unknown turn ${payload.turnId}`,
          ),
        );
        return;
      }
      try {
        channel.push(payload);
      } catch (error) {
        this.#fail(asError(error));
        return;
      }
    }
    for (const listener of this.#listeners) listener(payload);
  }

  #handleReady(event: WorkerReady): void {
    if (this.#ready !== undefined) {
      this.#fail(new Error("ACP worker sent worker.ready more than once"));
      return;
    }
    if (
      event.parentPid !== process.pid ||
      event.workerPid !== this.#child.pid
    ) {
      this.#fail(new Error("ACP worker readiness identity mismatch"));
      return;
    }
    this.#ready = event;
    if (this.#readyTimer !== undefined) clearTimeout(this.#readyTimer);
    this.#resolveReady(event);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#readyTimer !== undefined) clearTimeout(this.#readyTimer);
    if (this.#ready === undefined) this.#rejectReady(error);
    this.#rejectAll(error);
    if (this.#child.exitCode === null) this.#child.kill("SIGTERM");
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const turn of this.#turns.values()) turn.fail(error);
  }

  #workerEnvironment(options: PluginOptions): NodeJS.ProcessEnv {
    const keep = [
      "HOME",
      "PATH",
      "TMPDIR",
      "TEMP",
      "TMP",
      "USER",
      "USERNAME",
      "SHELL",
      "SystemRoot",
      "COMSPEC",
      "PATHEXT",
      "LOCALAPPDATA",
      "APPDATA",
    ];
    for (const server of Object.values(options.servers))
      keep.push(...server.forwardEnv);
    const environment: NodeJS.ProcessEnv = {
      OPENCODE_ACPX_TOKEN: this.#token,
      OPENCODE_ACPX_PARENT_PID: String(process.pid),
      OPENCODE_ACPX_MAX_FRAME_BYTES: String(this.#maxFrameBytes),
    };
    for (const name of new Set(keep)) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    return environment;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = promise.then(() => true);
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}
