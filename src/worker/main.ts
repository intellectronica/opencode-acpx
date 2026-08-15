import { createHash, randomUUID } from "node:crypto";

import { ZodError } from "zod";

import { DEFAULT_MAX_FRAME_BYTES } from "../constants.js";
import type {
  WorkerMethod,
  WorkerMethodParams,
  WorkerMethodResults,
} from "./messages.js";
import {
  authTokenSchema,
  BoundedNdjsonDecoder,
  encodeBoundedFrame,
  errorResponse,
  isWorkerMethod,
  parseMethodParams,
  parseMethodResult,
  requestEnvelopeSchema,
  successResponse,
  workerEvent,
  type RequestEnvelope,
  type ResponseEnvelope,
  type WorkerEnvelope,
} from "./protocol.js";
import { RuntimeHost, RuntimeHostError } from "./runtime-host.js";

const PARENT_CHECK_INTERVAL_MS = 1_000;
const MAX_REQUEST_LEDGER_ENTRIES = 1_024;

const token = authTokenSchema.parse(process.env.OPENCODE_ACPX_TOKEN);
const parentPid = positiveIntegerEnvironment("OPENCODE_ACPX_PARENT_PID");
const maxFrameBytes = optionalPositiveIntegerEnvironment(
  "OPENCODE_ACPX_MAX_FRAME_BYTES",
  DEFAULT_MAX_FRAME_BYTES,
);
const workerInstanceId = randomUUID();
const decoder = new BoundedNdjsonDecoder(maxFrameBytes);
const requestLedger = new Map<
  string,
  { fingerprint: string; response: Promise<ResponseEnvelope> }
>();
let configured = false;
let shuttingDown = false;
let requestChain = Promise.resolve();

function write(value: WorkerEnvelope): void {
  process.stdout.write(encodeBoundedFrame(value, maxFrameBytes));
}

const host = new RuntimeHost({
  emit: (event) => write(workerEvent(token, event)),
});

async function dispatch<Method extends WorkerMethod>(
  method: Method,
  params: WorkerMethodParams[Method],
): Promise<WorkerMethodResults[Method]> {
  if (!configured && method !== "configure" && method !== "dispose") {
    throw new RuntimeHostError(
      "NOT_CONFIGURED",
      "Worker must be configured before use",
    );
  }
  let result: WorkerMethodResults[WorkerMethod];
  switch (method) {
    case "configure": {
      await host.configure(params as WorkerMethodParams["configure"]);
      configured = true;
      result = {
        ok: true,
        workerInstanceId,
        capabilities: host.capabilities,
      };
      break;
    }
    case "catalogue":
      result = await host.catalogue(params as WorkerMethodParams["catalogue"]);
      break;
    case "turn.start":
      result = await host.startTurn(params as WorkerMethodParams["turn.start"]);
      break;
    case "turn.cancel": {
      const input = params as WorkerMethodParams["turn.cancel"];
      result = await host.cancelTurn(input.turnId, input.reason);
      break;
    }
    case "interaction.respond":
      host.respondInteraction(
        params as WorkerMethodParams["interaction.respond"],
      );
      result = { ok: true };
      break;
    case "interaction.elicitation.respond":
      host.respondElicitation(
        params as WorkerMethodParams["interaction.elicitation.respond"],
      );
      result = { ok: true };
      break;
    case "interaction.extension.respond":
      host.respondExtension(
        params as WorkerMethodParams["interaction.extension.respond"],
      );
      result = { ok: true };
      break;
    case "session.setConfig": {
      const input = params as WorkerMethodParams["session.setConfig"];
      await host.setConfig(
        input.serverId,
        input.sessionKey,
        input.key,
        input.value,
      );
      result = { ok: true };
      break;
    }
    case "session.setMode": {
      const input = params as WorkerMethodParams["session.setMode"];
      await host.setMode(input.serverId, input.sessionKey, input.mode);
      result = { ok: true };
      break;
    }
    case "session.close": {
      const input = params as WorkerMethodParams["session.close"];
      const state = await host.closeSession(
        input.serverId,
        input.sessionKey,
        input.discardPersistentState,
      );
      result = { ok: true, state };
      break;
    }
    case "dispose":
      await host.dispose();
      result = { ok: true };
      break;
  }
  return parseMethodResult(method, result);
}

async function processRequest(request: RequestEnvelope): Promise<void> {
  if (request.token !== token) {
    throw new FatalProtocolError("Worker request token mismatch");
  }
  if (!isWorkerMethod(request.method)) {
    write(
      errorResponse(
        token,
        request.id,
        "METHOD_NOT_FOUND",
        `Unknown worker method: ${request.method}`,
      ),
    );
    return;
  }
  const fingerprint = requestFingerprint(request);
  const existing = requestLedger.get(request.id);
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) {
      write(
        errorResponse(
          token,
          request.id,
          "REQUEST_ID_CONFLICT",
          `Request id ${request.id} was reused with different input`,
        ),
      );
      return;
    }
    write(await existing.response);
    return;
  }
  const response = executeRequest(request);
  requestLedger.set(request.id, { fingerprint, response });
  trimRequestLedger();
  const resolved = await response;
  write(resolved);
  if (request.method === "dispose" && resolved.error === undefined)
    void shutdown(0);
}

async function executeRequest(
  request: RequestEnvelope,
): Promise<ResponseEnvelope> {
  try {
    if (!isWorkerMethod(request.method)) {
      return errorResponse(
        token,
        request.id,
        "METHOD_NOT_FOUND",
        `Unknown worker method: ${request.method}`,
      );
    }
    const params = parseMethodParams(request.method, request.params);
    return successResponse(
      token,
      request.id,
      await dispatch(request.method, params),
    );
  } catch (error) {
    return responseForError(request.id, error);
  }
}

function responseForError(id: string, error: unknown): ResponseEnvelope {
  if (error instanceof RuntimeHostError) {
    return errorResponse(token, id, error.code, error.message, error.details);
  }
  if (error instanceof ZodError) {
    return errorResponse(
      token,
      id,
      "INVALID_PARAMS",
      "Invalid worker method parameters",
      error.issues,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "WORKER_ERROR";
  return errorResponse(token, id, code, message);
}

function handleChunk(chunk: Buffer): void {
  if (shuttingDown) return;
  try {
    const lines = decoder.push(chunk);
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new FatalProtocolError("Worker received invalid JSON", {
          cause: error,
        });
      }
      const parsed = requestEnvelopeSchema.safeParse(value);
      if (!parsed.success) {
        throw new FatalProtocolError(
          "Worker received an invalid request envelope",
          {
            cause: parsed.error,
          },
        );
      }
      requestChain = requestChain.then(
        async () => await processRequest(parsed.data),
      );
      void requestChain.catch((error: unknown) => fatal(error));
    }
  } catch (error) {
    fatal(error);
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(parentTimer);
  process.stdin.pause();
  await host.dispose().catch((error: unknown) => {
    process.stderr.write(`${formatError(error)}\n`);
  });
  process.exitCode = exitCode;
  process.stdout.end();
}

function fatal(error: unknown): void {
  if (shuttingDown) return;
  process.stderr.write(`${formatError(error)}\n`);
  void shutdown(1);
}

function parentIsAlive(): boolean {
  if (process.ppid !== parentPid) return false;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function trimRequestLedger(): void {
  while (requestLedger.size > MAX_REQUEST_LEDGER_ENTRIES) {
    const oldest = requestLedger.keys().next().value;
    if (oldest === undefined) return;
    requestLedger.delete(oldest);
  }
}

function requestFingerprint(request: RequestEnvelope): string {
  return createHash("sha256")
    .update(stableJson({ method: request.method, params: request.params }))
    .digest("hex");
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

function positiveIntegerEnvironment(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${name}`);
  return value;
}

function optionalPositiveIntegerEnvironment(
  name: string,
  fallback: number,
): number {
  if (process.env[name] === undefined) return fallback;
  return positiveIntegerEnvironment(name);
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

class FatalProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FatalProtocolError";
  }
}

process.stdin.on("data", handleChunk);
process.stdin.once("end", () => {
  try {
    decoder.end();
    void shutdown(0);
  } catch (error) {
    fatal(error);
  }
});
process.stdin.once("error", fatal);
process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("disconnect", () => void shutdown(0));

const parentTimer = setInterval(() => {
  if (!parentIsAlive())
    fatal(
      new Error(
        `OpenCode parent process ${String(parentPid)} is no longer alive`,
      ),
    );
}, PARENT_CHECK_INTERVAL_MS);
parentTimer.unref();

if (!parentIsAlive()) {
  fatal(new Error(`OpenCode parent process ${String(parentPid)} is not alive`));
} else {
  write(
    workerEvent(token, {
      type: "worker.ready",
      workerInstanceId,
      workerPid: process.pid,
      parentPid,
      capabilities: host.capabilities,
    }),
  );
}
