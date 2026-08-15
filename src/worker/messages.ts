import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntimeAvailableCommand,
  AcpRuntimeCapabilities,
  AcpRuntimeEvent,
  AcpRuntimeTurnResult,
} from "acpx/runtime";

import type { PluginOptions } from "../config.js";

export interface ConfigureParams {
  pluginInstanceId: string;
  directory: string;
  options: PluginOptions;
}

export interface CatalogueParams {
  serverId: string;
  cwd: string;
}

export interface TurnStartParams {
  turnId: string;
  serverId: string;
  sessionKey: string;
  cwd: string;
  requestId: string;
  text: string;
  modelId?: string;
  mode?: string;
  attachments?: { mediaType: string; data: string }[];
}

export interface InteractionResponseParams {
  interactionId: string;
  /** Verifies and selects the exact option offered by the ACP agent when supplied. */
  decision: AcpPermissionDecision;
  optionId?: string;
}

export interface ElicitationResponseParams {
  interactionId: string;
  response: unknown;
}

export type ExtensionResponseParams =
  | { interactionId: string; result: unknown; error?: never }
  | {
      interactionId: string;
      result?: never;
      error: { code: string; message: string; details?: unknown };
    };

export interface WorkerFeatureSupport {
  supported: boolean;
  code?: string;
  message?: string;
}

export interface WorkerCapabilityReport {
  permissions: WorkerFeatureSupport;
  extensions: WorkerFeatureSupport;
  elicitation: WorkerFeatureSupport;
  rawProtocolEvents: WorkerFeatureSupport;
  clientCapabilityControl: WorkerFeatureSupport;
}

export interface ConfigureResult {
  ok: true;
  workerInstanceId: string;
  capabilities: WorkerCapabilityReport;
}

export interface CatalogueModel {
  id: string;
  name?: string;
}

export interface CatalogueResult {
  serverId: string;
  cwd: string;
  currentModelId?: string;
  models: CatalogueModel[];
  configOptions: unknown[];
  availableCommands: AcpRuntimeAvailableCommand[];
  runtimeCapabilities: AcpRuntimeCapabilities;
  featureSupport: WorkerCapabilityReport;
  statusDetails?: Record<string, unknown>;
}

export interface TurnStartResult {
  ok: true;
  state: "started" | "existing";
}

export interface TurnCancelResult {
  ok: true;
  state: "cancelled" | "not_found" | "already_terminal";
}

export interface OkResult {
  ok: true;
}

export interface WorkerTurnEvent {
  type: "turn.event";
  turnId: string;
  index: number;
  event: AcpRuntimeEvent;
}

export interface WorkerTurnResult {
  type: "turn.result";
  turnId: string;
  index: number;
  result: AcpRuntimeTurnResult;
}

export interface PermissionInteraction {
  type: "interaction.permission";
  turnId: string;
  index: number;
  interactionId: string;
  serverId: string;
  sessionKey: string;
  expiresAt: number;
  request: AcpPermissionRequest["raw"];
  inferredKind?: string;
}

interface CorrelatedWorkerEvent {
  serverId: string;
  sessionKey?: string;
  turnId?: string;
}

export type ElicitationInteraction = CorrelatedWorkerEvent & {
  type: "interaction.elicitation";
  interactionId: string;
  expiresAt: number;
  request: unknown;
};

export type ExtensionInteraction = CorrelatedWorkerEvent & {
  type: "interaction.extension";
  interactionId: string;
  expiresAt: number;
  method: string;
  params: unknown;
};

export type RawProtocolEvent = CorrelatedWorkerEvent & {
  type: "protocol.raw";
  direction: "client-to-agent" | "agent-to-client";
  message: unknown;
};

export type SessionUpdateEvent = CorrelatedWorkerEvent & {
  type: "session.update";
  notification: unknown;
};

export type ElicitationCompleteEvent = CorrelatedWorkerEvent & {
  type: "elicitation.complete";
  notification: unknown;
};

export type ExtensionNotificationEvent = CorrelatedWorkerEvent & {
  type: "extension.notification";
  method: string;
  params: unknown;
};

export type AuthMetadataEvent = CorrelatedWorkerEvent & {
  type: "auth.metadata";
  metadata: unknown;
};

export interface WorkerDiagnostic {
  type: "diagnostic";
  level: "debug" | "info" | "warning" | "error";
  code?: string;
  message: string;
  serverId?: string;
  details?: unknown;
}

export interface WorkerReady {
  type: "worker.ready";
  workerInstanceId: string;
  workerPid: number;
  parentPid: number;
  capabilities: WorkerCapabilityReport;
}

export type RuntimeWorkerEvent =
  | WorkerTurnEvent
  | WorkerTurnResult
  | PermissionInteraction
  | ElicitationInteraction
  | ExtensionInteraction
  | RawProtocolEvent
  | SessionUpdateEvent
  | ElicitationCompleteEvent
  | ExtensionNotificationEvent
  | AuthMetadataEvent
  | WorkerDiagnostic
  | WorkerReady;

export type WorkerMethod =
  | "configure"
  | "catalogue"
  | "turn.start"
  | "turn.cancel"
  | "interaction.respond"
  | "interaction.elicitation.respond"
  | "interaction.extension.respond"
  | "session.setConfig"
  | "session.setMode"
  | "session.close"
  | "dispose";

export interface WorkerMethodParams {
  configure: ConfigureParams;
  catalogue: CatalogueParams;
  "turn.start": TurnStartParams;
  "turn.cancel": { turnId: string; reason?: string };
  "interaction.respond": InteractionResponseParams;
  "interaction.elicitation.respond": ElicitationResponseParams;
  "interaction.extension.respond": ExtensionResponseParams;
  "session.setConfig": {
    serverId: string;
    sessionKey: string;
    key: string;
    value: string;
  };
  "session.setMode": { serverId: string; sessionKey: string; mode: string };
  "session.close": {
    serverId: string;
    sessionKey: string;
    discardPersistentState?: boolean;
  };
  dispose: Record<string, never>;
}

export interface WorkerMethodResults {
  configure: ConfigureResult;
  catalogue: CatalogueResult;
  "turn.start": TurnStartResult;
  "turn.cancel": TurnCancelResult;
  "interaction.respond": OkResult;
  "interaction.elicitation.respond": OkResult;
  "interaction.extension.respond": OkResult;
  "session.setConfig": OkResult;
  "session.setMode": OkResult;
  "session.close": { ok: true; state: "closed" | "not_found" };
  dispose: OkResult;
}
