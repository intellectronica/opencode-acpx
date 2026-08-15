import type { AcpPermissionDecision } from "acpx/runtime";
import type { ToolContext, ToolResult } from "@opencode-ai/plugin";

import type { PermissionInteraction } from "../worker/messages.js";
import {
  isPermissionAskedEvent,
  isPermissionRepliedEvent,
  isSessionDeletedEvent,
  sessionDeletedId,
} from "./events.js";

type PermissionMode = "ask" | "allow" | "deny";
type PermissionFallback = "deny" | "fail";

export interface PermissionToolInput {
  interactionId: string;
  serverId: string;
  sessionKey: string;
  expiresAt: number;
  request?: unknown;
  inferredKind?: string;
}

export interface PermissionBrokerOptions {
  mode: PermissionMode;
  fallback: PermissionFallback;
  now?: () => number;
}

interface PendingPermission {
  event: PermissionInteraction;
  serverId?: string;
  openCodeSessionId?: string;
  callId?: string;
  permissionRequestId?: string;
  reply?: "once" | "always" | "reject";
}

interface ToolExecutionInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface PermissionDescription {
  title: string;
  resource: string;
  repeatableResource: string;
  kind: string;
}

const MAX_DISPLAY_LENGTH = 512;

export class PermissionInteractionBroker {
  readonly #mode: PermissionMode;
  readonly #fallback: PermissionFallback;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingPermission>();
  readonly #sessionByKey = new Map<string, string>();
  readonly #keysBySession = new Map<string, Set<string>>();
  readonly #interactionByCall = new Map<string, string>();
  readonly #interactionByRequest = new Map<string, string>();

  constructor(options: PermissionBrokerOptions) {
    this.#mode = options.mode;
    this.#fallback = options.fallback;
    this.#now = options.now ?? Date.now;
  }

  bindSession(sessionKey: string, openCodeSessionId: string): void {
    const previous = this.#sessionByKey.get(sessionKey);
    if (previous === openCodeSessionId) return;
    if (previous !== undefined)
      this.#keysBySession.get(previous)?.delete(sessionKey);
    this.#sessionByKey.set(sessionKey, openCodeSessionId);
    const keys =
      this.#keysBySession.get(openCodeSessionId) ?? new Set<string>();
    keys.add(sessionKey);
    this.#keysBySession.set(openCodeSessionId, keys);
    for (const pending of this.#pending.values()) {
      if (pending.event.sessionKey === sessionKey)
        pending.openCodeSessionId = openCodeSessionId;
    }
  }

  observeWorkerEvent(event: PermissionInteraction, serverId?: string): void {
    this.#purgeExpired();
    const openCodeSessionId = this.#sessionByKey.get(event.sessionKey);
    this.#pending.set(event.interactionId, {
      event,
      ...(serverId === undefined ? {} : { serverId }),
      ...(openCodeSessionId === undefined ? {} : { openCodeSessionId }),
    });
  }

  beforeToolExecute(
    toolName: string,
    input: ToolExecutionInput,
    args: unknown,
  ): void {
    if (input.tool !== toolName || !isPermissionToolInput(args)) return;
    const pending = this.#pending.get(args.interactionId);
    if (!this.#matchesToolInput(pending, args, input.sessionID)) return;
    pending.callId = input.callID;
    this.#interactionByCall.set(
      correlationKey(input.sessionID, input.callID),
      args.interactionId,
    );
  }

  ingestRuntimeEvent(event: unknown): void {
    if (isPermissionAskedEvent(event)) {
      const tool = event.properties.tool;
      if (tool === undefined) return;
      const callKey = correlationKey(event.properties.sessionID, tool.callID);
      const interactionId = this.#interactionByCall.get(callKey);
      if (interactionId === undefined) return;
      const pending = this.#pending.get(interactionId);
      if (
        pending === undefined ||
        pending.openCodeSessionId !== event.properties.sessionID
      )
        return;
      pending.permissionRequestId = event.properties.id;
      this.#interactionByRequest.set(
        correlationKey(event.properties.sessionID, event.properties.id),
        interactionId,
      );
      return;
    }
    if (isPermissionRepliedEvent(event)) {
      const requestKey = correlationKey(
        event.properties.sessionID,
        event.properties.requestID,
      );
      const interactionId = this.#interactionByRequest.get(requestKey);
      if (interactionId === undefined) return;
      const pending = this.#pending.get(interactionId);
      if (pending === undefined || pending.reply !== undefined) return;
      pending.reply = event.properties.reply;
    }
  }

  deletedSessionKeys(event: unknown): string[] {
    if (!isSessionDeletedEvent(event)) return [];
    return this.deleteSession(sessionDeletedId(event));
  }

  deleteSession(openCodeSessionId: string): string[] {
    const keys = [...(this.#keysBySession.get(openCodeSessionId) ?? [])];
    for (const key of keys) this.#sessionByKey.delete(key);
    this.#keysBySession.delete(openCodeSessionId);
    for (const [interactionId, pending] of this.#pending) {
      if (pending.openCodeSessionId === openCodeSessionId)
        this.#finish(interactionId, pending);
    }
    return keys;
  }

  async execute(
    input: PermissionToolInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const pending = this.#pending.get(input.interactionId);
    if (
      !this.#matchesToolInput(pending, input, context.sessionID) ||
      pending.callId === undefined
    ) {
      return permissionResult(
        input.interactionId,
        { outcome: "cancel" },
        "invalid or expired request",
      );
    }
    if (this.#now() >= pending.event.expiresAt) {
      this.#finish(input.interactionId, pending);
      return permissionResult(
        input.interactionId,
        { outcome: "cancel" },
        "request expired",
      );
    }

    let decision: AcpPermissionDecision;
    if (this.#mode === "allow") {
      decision = supportedDecision(pending.event.request, "once");
    } else if (this.#mode === "deny") {
      decision = supportedDecision(pending.event.request, "reject");
    } else {
      decision = await this.#ask(pending, context);
    }
    this.#finish(input.interactionId, pending);
    return permissionResult(input.interactionId, decision);
  }

  async #ask(
    pending: PendingPermission,
    context: ToolContext,
  ): Promise<AcpPermissionDecision> {
    const description = describePermission(
      pending.event.request,
      pending.event.inferredKind,
    );
    context.metadata({
      title: description.title,
      metadata: { acpServer: pending.serverId, acpToolKind: description.kind },
    });
    const ask = context.ask({
      permission: `acp.${pending.serverId ?? "unknown"}.${description.kind}`,
      patterns: [description.resource],
      always: [description.repeatableResource],
      metadata: {
        title: description.title,
        acpServer: pending.serverId ?? "unknown",
        acpToolKind: description.kind,
      },
    });
    try {
      await withAbort(ask, context.abort);
    } catch {
      if (context.abort.aborted) return { outcome: "cancel" };
      if (pending.reply !== undefined)
        return supportedDecision(pending.event.request, pending.reply);
      return this.#fallback === "deny"
        ? supportedDecision(pending.event.request, "reject")
        : { outcome: "cancel" };
    }
    return supportedDecision(pending.event.request, pending.reply ?? "once");
  }

  #matchesToolInput(
    pending: PendingPermission | undefined,
    input: PermissionToolInput,
    openCodeSessionId: string,
  ): pending is PendingPermission {
    return (
      pending !== undefined &&
      pending.event.sessionKey === input.sessionKey &&
      pending.event.expiresAt === input.expiresAt &&
      (pending.serverId === undefined || pending.serverId === input.serverId) &&
      pending.openCodeSessionId === openCodeSessionId
    );
  }

  #finish(interactionId: string, pending: PendingPermission): void {
    this.#pending.delete(interactionId);
    if (
      pending.callId !== undefined &&
      pending.openCodeSessionId !== undefined
    ) {
      this.#interactionByCall.delete(
        correlationKey(pending.openCodeSessionId, pending.callId),
      );
    }
    if (
      pending.permissionRequestId !== undefined &&
      pending.openCodeSessionId !== undefined
    ) {
      this.#interactionByRequest.delete(
        correlationKey(pending.openCodeSessionId, pending.permissionRequestId),
      );
    }
  }

  #purgeExpired(): void {
    for (const [interactionId, pending] of this.#pending) {
      if (this.#now() >= pending.event.expiresAt)
        this.#finish(interactionId, pending);
    }
  }
}

export function isPermissionToolInput(
  value: unknown,
): value is PermissionToolInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.interactionId === "string" &&
    typeof input.serverId === "string" &&
    typeof input.sessionKey === "string" &&
    typeof input.expiresAt === "number" &&
    Number.isSafeInteger(input.expiresAt)
  );
}

function permissionResult(
  interactionId: string,
  decision: AcpPermissionDecision,
  reason?: string,
): ToolResult {
  return {
    title: decision.outcome.startsWith("allow")
      ? "ACP permission approved"
      : "ACP permission denied",
    output: JSON.stringify({ interactionId, decision }),
    metadata: {
      interactionId,
      decision: decision.outcome,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

function supportedDecision(
  request: unknown,
  reply: "once" | "always" | "reject",
): AcpPermissionDecision {
  const kinds = permissionOptionKinds(request);
  if (reply === "always") {
    if (kinds.has("allow_always")) return { outcome: "allow_always" };
    if (kinds.has("allow_once")) return { outcome: "allow_once" };
  }
  if (reply === "once") {
    if (kinds.has("allow_once")) return { outcome: "allow_once" };
    if (kinds.has("allow_always")) return { outcome: "allow_always" };
  }
  if (reply === "reject") {
    if (kinds.has("reject_once")) return { outcome: "reject_once" };
    if (kinds.has("reject_always")) return { outcome: "reject_always" };
  }
  return { outcome: "cancel" };
}

function permissionOptionKinds(request: unknown): Set<string> {
  if (typeof request !== "object" || request === null || Array.isArray(request))
    return new Set();
  const options = (request as Record<string, unknown>).options;
  if (!Array.isArray(options)) return new Set();
  const result = new Set<string>();
  for (const option of options) {
    if (typeof option !== "object" || option === null || Array.isArray(option))
      continue;
    const kind = (option as Record<string, unknown>).kind;
    if (typeof kind === "string") result.add(kind);
  }
  return result;
}

function describePermission(
  request: unknown,
  inferredKind?: string,
): PermissionDescription {
  const fallback = sanitiseDisplay(inferredKind ?? "other");
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    return {
      title: "ACP agent request",
      resource: fallback,
      repeatableResource: fallback,
      kind: fallback,
    };
  }
  const raw = request as Record<string, unknown>;
  const toolCall =
    typeof raw.toolCall === "object" &&
    raw.toolCall !== null &&
    !Array.isArray(raw.toolCall)
      ? (raw.toolCall as Record<string, unknown>)
      : {};
  const kind = sanitiseDisplay(
    typeof toolCall.kind === "string"
      ? toolCall.kind
      : (inferredKind ?? "other"),
  );
  const title = sanitiseDisplay(
    typeof toolCall.title === "string"
      ? toolCall.title
      : typeof toolCall.name === "string"
        ? toolCall.name
        : "ACP agent request",
  );
  const input =
    typeof toolCall.rawInput === "object" &&
    toolCall.rawInput !== null &&
    !Array.isArray(toolCall.rawInput)
      ? (toolCall.rawInput as Record<string, unknown>)
      : {};
  const specific = [input.command, input.path, input.url].find(
    (value) => typeof value === "string",
  );
  const resource = sanitiseDisplay(
    typeof specific === "string" ? specific : title,
  );
  const name =
    typeof toolCall.name === "string" ? sanitiseDisplay(toolCall.name) : kind;
  return {
    title,
    resource,
    repeatableResource: specific === undefined ? name : resource,
    kind,
  };
}

function sanitiseDisplay(value: string): string {
  let normalised = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    normalised += code <= 31 || code === 127 ? " " : character;
  }
  normalised = normalised.trim();
  return normalised.slice(0, MAX_DISPLAY_LENGTH) || "other";
}

function correlationKey(sessionId: string, id: string): string {
  return `${sessionId}\u0000${id}`;
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("ACP interaction aborted"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    void promise.catch(() => undefined);
  }
}
