import { z } from "zod";

import { pluginOptionsSchema } from "../config.js";
import { RPC_PROTOCOL_VERSION } from "../constants.js";
import type {
  RuntimeWorkerEvent,
  WorkerMethod,
  WorkerMethodParams,
  WorkerMethodResults,
} from "./messages.js";

const MAX_IDENTIFIER_CHARS = 512;
const MAX_PATH_CHARS = 32_768;
const MAX_METHOD_CHARS = 128;
const AUTH_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

const identifierSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_CHARS)
  .refine(
    (value) => hasNoControlCharacters(value),
    "Identifiers must not contain control characters",
  );

function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}
const pathSchema = z.string().min(1).max(MAX_PATH_CHARS);
export const authTokenSchema = z
  .string()
  .regex(AUTH_TOKEN_PATTERN, "Invalid worker authentication token");

export const permissionDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("allow_once") }).strict(),
  z.object({ outcome: z.literal("allow_always") }).strict(),
  z.object({ outcome: z.literal("reject_once") }).strict(),
  z.object({ outcome: z.literal("reject_always") }).strict(),
  z.object({ outcome: z.literal("cancel") }).strict(),
]);

export const configureParamsSchema = z
  .object({
    pluginInstanceId: identifierSchema,
    directory: pathSchema,
    options: pluginOptionsSchema,
  })
  .strict();

export const catalogueParamsSchema = z
  .object({ serverId: identifierSchema, cwd: pathSchema })
  .strict();

const attachmentSchema = z
  .object({ mediaType: z.string().min(1).max(512), data: z.string() })
  .strict();

export const turnStartParamsSchema = z
  .object({
    turnId: identifierSchema,
    serverId: identifierSchema,
    sessionKey: identifierSchema,
    cwd: pathSchema,
    requestId: identifierSchema,
    text: z.string(),
    modelId: identifierSchema.optional(),
    mode: identifierSchema.optional(),
    attachments: z.array(attachmentSchema).max(64).optional(),
  })
  .strict();

export const turnCancelParamsSchema = z
  .object({
    turnId: identifierSchema,
    reason: z.string().max(4_096).optional(),
  })
  .strict();

export const interactionResponseParamsSchema = z
  .object({
    interactionId: identifierSchema,
    decision: permissionDecisionSchema,
    optionId: identifierSchema.optional(),
  })
  .strict();

export const elicitationResponseParamsSchema = z
  .object({ interactionId: identifierSchema, response: z.unknown().optional() })
  .strict()
  .refine(
    (value) => Object.hasOwn(value, "response"),
    "An elicitation response must contain response",
  );

const reverseInteractionErrorSchema = z
  .object({
    code: z.string().min(1).max(256),
    message: z.string().min(1),
    details: z.unknown().optional(),
  })
  .strict();

export const extensionResponseParamsSchema = z
  .object({
    interactionId: identifierSchema,
    result: z.unknown().optional(),
    error: reverseInteractionErrorSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.hasOwn(value, "result") !== Object.hasOwn(value, "error"),
    "An extension response must contain exactly one of result or error",
  );

export const sessionSetConfigParamsSchema = z
  .object({
    serverId: identifierSchema,
    sessionKey: identifierSchema,
    key: identifierSchema,
    value: z.string().max(65_536),
  })
  .strict();

export const sessionSetModeParamsSchema = z
  .object({
    serverId: identifierSchema,
    sessionKey: identifierSchema,
    mode: identifierSchema,
  })
  .strict();

export const sessionCloseParamsSchema = z
  .object({
    serverId: identifierSchema,
    sessionKey: identifierSchema,
    discardPersistentState: z.boolean().optional(),
  })
  .strict();

export const disposeParamsSchema = z.object({}).strict();

const methodParamSchemas = {
  configure: configureParamsSchema,
  catalogue: catalogueParamsSchema,
  "turn.start": turnStartParamsSchema,
  "turn.cancel": turnCancelParamsSchema,
  "interaction.respond": interactionResponseParamsSchema,
  "interaction.elicitation.respond": elicitationResponseParamsSchema,
  "interaction.extension.respond": extensionResponseParamsSchema,
  "session.setConfig": sessionSetConfigParamsSchema,
  "session.setMode": sessionSetModeParamsSchema,
  "session.close": sessionCloseParamsSchema,
  dispose: disposeParamsSchema,
} as const satisfies Record<WorkerMethod, z.ZodType>;

const featureSupportSchema = z
  .object({
    supported: z.boolean(),
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
const capabilityReportSchema = z
  .object({
    permissions: featureSupportSchema,
    extensions: featureSupportSchema,
    elicitation: featureSupportSchema,
    rawProtocolEvents: featureSupportSchema,
    clientCapabilityControl: featureSupportSchema,
  })
  .strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();

const configureResultSchema = okResultSchema
  .extend({
    workerInstanceId: identifierSchema,
    capabilities: capabilityReportSchema,
  })
  .strict();
const catalogueModelSchema = z
  .object({ id: identifierSchema, name: z.string().min(1).optional() })
  .strict();
const availableCommandSchema = z
  .object({
    name: identifierSchema,
    description: z.string().optional(),
    hasInput: z.boolean().optional(),
  })
  .strict();
const runtimeCapabilitiesSchema = z
  .object({
    controls: z.array(z.string()),
    configOptionKeys: z.array(z.string()).optional(),
  })
  .strict();
const catalogueResultSchema = z
  .object({
    serverId: identifierSchema,
    cwd: pathSchema,
    currentModelId: identifierSchema.optional(),
    models: z.array(catalogueModelSchema),
    configOptions: z.array(z.unknown()),
    availableCommands: z.array(availableCommandSchema),
    runtimeCapabilities: runtimeCapabilitiesSchema,
    featureSupport: capabilityReportSchema,
    statusDetails: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const turnStartResultSchema = okResultSchema
  .extend({ state: z.enum(["started", "existing"]) })
  .strict();
const turnCancelResultSchema = okResultSchema
  .extend({ state: z.enum(["cancelled", "not_found", "already_terminal"]) })
  .strict();
const sessionCloseResultSchema = okResultSchema
  .extend({ state: z.enum(["closed", "not_found"]) })
  .strict();

const methodResultSchemas = {
  configure: configureResultSchema,
  catalogue: catalogueResultSchema,
  "turn.start": turnStartResultSchema,
  "turn.cancel": turnCancelResultSchema,
  "interaction.respond": okResultSchema,
  "interaction.elicitation.respond": okResultSchema,
  "interaction.extension.respond": okResultSchema,
  "session.setConfig": okResultSchema,
  "session.setMode": okResultSchema,
  "session.close": sessionCloseResultSchema,
  dispose: okResultSchema,
} as const satisfies Record<WorkerMethod, z.ZodType>;

export const requestEnvelopeSchema = z
  .object({
    kind: z.literal("request"),
    version: z.literal(RPC_PROTOCOL_VERSION),
    token: authTokenSchema,
    id: identifierSchema,
    method: z.string().min(1).max(MAX_METHOD_CHARS),
    params: z.unknown().optional(),
  })
  .strict()
  .refine(
    (value) => Object.hasOwn(value, "params"),
    "A request must contain params",
  );

const errorPayloadSchema = z
  .object({
    code: z.string().min(1).max(256),
    message: z.string().min(1),
    details: z.unknown().optional(),
  })
  .strict();

export const responseEnvelopeSchema = z
  .object({
    kind: z.literal("response"),
    version: z.literal(RPC_PROTOCOL_VERSION),
    token: authTokenSchema,
    id: identifierSchema,
    result: z.unknown().optional(),
    error: errorPayloadSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.hasOwn(value, "result") !== Object.hasOwn(value, "error"),
    "A response must contain exactly one of result or error",
  );

export const eventEnvelopeSchema = z
  .object({
    kind: z.literal("event"),
    version: z.literal(RPC_PROTOCOL_VERSION),
    token: authTokenSchema,
    event: z.unknown().optional(),
  })
  .strict()
  .refine(
    (value) => Object.hasOwn(value, "event"),
    "An event envelope must contain an event",
  );

const usageCostSchema = z
  .object({ amount: z.number().optional(), currency: z.string().optional() })
  .strict();
const usageBreakdownSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedReadTokens: z.number().optional(),
    cachedWriteTokens: z.number().optional(),
    thoughtTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  })
  .strict();
const acpRuntimeEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text_delta"),
      text: z.string(),
      stream: z.enum(["output", "thought"]).optional(),
      tag: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("status"),
      text: z.string(),
      tag: z.string().optional(),
      used: z.number().optional(),
      size: z.number().optional(),
      cost: usageCostSchema.optional(),
      breakdown: usageBreakdownSchema.optional(),
      availableCommands: z.array(availableCommandSchema).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_call"),
      text: z.string(),
      tag: z.string().optional(),
      toolCallId: z.string().optional(),
      status: z.string().optional(),
      title: z.string().optional(),
      kind: z.string().optional(),
      locations: z.array(z.unknown()).optional(),
      rawInput: z.unknown().optional(),
      rawOutput: z.unknown().optional(),
      content: z.array(z.unknown()).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("done"), stopReason: z.string().optional() })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      message: z.string(),
      code: z.string().optional(),
      detailCode: z.string().optional(),
      retryable: z.boolean().optional(),
    })
    .strict(),
]);
const turnResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      stopReason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
      stopReason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      error: z
        .object({
          message: z.string(),
          code: z.string().optional(),
          detailCode: z.string().optional(),
          retryable: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
]);

const correlatedFields = {
  serverId: identifierSchema,
  sessionKey: identifierSchema.optional(),
  turnId: identifierSchema.optional(),
};

export const runtimeWorkerEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("turn.event"),
      turnId: identifierSchema,
      index: z.number().int().nonnegative(),
      event: acpRuntimeEventSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("interaction.elicitation"),
      ...correlatedFields,
      interactionId: identifierSchema,
      expiresAt: z.number().int().nonnegative(),
      request: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("interaction.extension"),
      ...correlatedFields,
      interactionId: identifierSchema,
      expiresAt: z.number().int().nonnegative(),
      method: z.string().min(1),
      params: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("protocol.raw"),
      ...correlatedFields,
      direction: z.enum(["client-to-agent", "agent-to-client"]),
      message: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("session.update"),
      ...correlatedFields,
      notification: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("elicitation.complete"),
      ...correlatedFields,
      notification: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("extension.notification"),
      ...correlatedFields,
      method: z.string().min(1),
      params: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("auth.metadata"),
      ...correlatedFields,
      metadata: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn.result"),
      turnId: identifierSchema,
      index: z.number().int().nonnegative(),
      result: turnResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("interaction.permission"),
      turnId: identifierSchema,
      index: z.number().int().nonnegative(),
      interactionId: identifierSchema,
      serverId: identifierSchema,
      sessionKey: identifierSchema,
      expiresAt: z.number().int().nonnegative(),
      request: z.unknown(),
      inferredKind: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("diagnostic"),
      level: z.enum(["debug", "info", "warning", "error"]),
      code: z.string().optional(),
      message: z.string(),
      serverId: z.string().optional(),
      details: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("worker.ready"),
      workerInstanceId: identifierSchema,
      workerPid: z.number().int().positive(),
      parentPid: z.number().int().positive(),
      capabilities: capabilityReportSchema,
    })
    .strict(),
]);

export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;
export type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type WorkerEnvelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

export function isWorkerMethod(method: string): method is WorkerMethod {
  return Object.hasOwn(methodParamSchemas, method);
}

export function parseMethodParams<Method extends WorkerMethod>(
  method: Method,
  params: unknown,
): WorkerMethodParams[Method] {
  return methodParamSchemas[method].parse(params) as WorkerMethodParams[Method];
}

export function parseMethodResult<Method extends WorkerMethod>(
  method: Method,
  result: unknown,
): WorkerMethodResults[Method] {
  return methodResultSchemas[method].parse(
    result,
  ) as WorkerMethodResults[Method];
}

export function parseRuntimeWorkerEvent(event: unknown): RuntimeWorkerEvent {
  return runtimeWorkerEventSchema.parse(event) as RuntimeWorkerEvent;
}

export function successResponse(
  token: string,
  id: string,
  result: unknown,
): ResponseEnvelope {
  return {
    kind: "response",
    version: RPC_PROTOCOL_VERSION,
    token,
    id,
    result: result === undefined ? null : result,
  };
}

export function errorResponse(
  token: string,
  id: string,
  code: string,
  message: string,
  details?: unknown,
): ResponseEnvelope {
  return {
    kind: "response",
    version: RPC_PROTOCOL_VERSION,
    token,
    id,
    error:
      details === undefined ? { code, message } : { code, message, details },
  };
}

export function workerEvent(
  token: string,
  event: RuntimeWorkerEvent,
): EventEnvelope {
  return { kind: "event", version: RPC_PROTOCOL_VERSION, token, event };
}

/** Incremental NDJSON framing which rejects an oversized line before buffering another chunk. */
export class BoundedNdjsonDecoder {
  readonly #maxFrameBytes: number;
  #parts: Buffer[] = [];
  #frameBytes = 0;

  constructor(maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new TypeError("maxFrameBytes must be a positive safe integer");
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer | string): string[] {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const frames: string[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      this.#append(bytes.subarray(offset, end));
      if (newline === -1) break;
      frames.push(this.#takeFrame());
      offset = newline + 1;
    }
    return frames;
  }

  end(): void {
    if (this.#frameBytes !== 0)
      throw new Error("Incomplete NDJSON frame at end of stream");
  }

  #append(part: Buffer): void {
    if (this.#frameBytes + part.length > this.#maxFrameBytes) {
      throw new Error(
        `NDJSON frame exceeds ${String(this.#maxFrameBytes)} bytes`,
      );
    }
    if (part.length !== 0) {
      this.#parts.push(part);
      this.#frameBytes += part.length;
    }
  }

  #takeFrame(): string {
    let frame = Buffer.concat(this.#parts, this.#frameBytes);
    if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
    this.#parts = [];
    this.#frameBytes = 0;
    return frame.toString("utf8");
  }
}

export function encodeBoundedFrame(
  value: WorkerEnvelope,
  maxFrameBytes: number,
): string {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > maxFrameBytes) {
    throw new Error(`NDJSON frame exceeds ${String(maxFrameBytes)} bytes`);
  }
  return encoded;
}
