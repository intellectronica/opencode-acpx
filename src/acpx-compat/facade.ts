import type {
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
} from "acpx/runtime";

import {
  AcpCompatBroker,
  type AcpCompatBrokerOptions,
  type AcpCompatRequestOptions,
} from "./broker.js";
import {
  ACPX_COMPAT_CONTRACT_VERSION,
  type AcpCompatAuthObservation,
  type AcpCompatCapabilities,
  type AcpCompatDiagnostic,
  type AcpCompatRawMessageInput,
  type AcpCompatRouteContext,
} from "./contracts.js";

export const ACPX_COMPAT_FACADE: unique symbol = Symbol.for(
  "opencode-acpx.acpx-compat.facade.v1",
) as never;

export interface AcpCompatTransportHandlers {
  observeRawMessage(input: AcpCompatRawMessageInput): Promise<void>;
  createElicitation(
    request: CreateElicitationRequest,
    context: AcpCompatRouteContext,
    options?: AcpCompatRequestOptions,
  ): Promise<CreateElicitationResponse>;
  completeElicitation(
    notification: CompleteElicitationNotification,
    context: AcpCompatRouteContext,
  ): Promise<void>;
  reverseRequest(
    method: string,
    params: unknown,
    context: AcpCompatRouteContext,
    options?: AcpCompatRequestOptions,
  ): Promise<unknown>;
  reverseNotification(
    method: string,
    params: unknown,
    context: AcpCompatRouteContext,
  ): Promise<void>;
  authMetadata(
    observation: AcpCompatAuthObservation,
    context: AcpCompatRouteContext,
  ): Promise<void>;
  sessionUpdate(
    notification: SessionNotification,
    context: AcpCompatRouteContext,
  ): Promise<void>;
}

export interface AcpCompatSurface {
  readonly version: typeof ACPX_COMPAT_CONTRACT_VERSION;
  readonly broker: AcpCompatBroker;
  readonly capabilities: AcpCompatCapabilities;
  readonly diagnostics: readonly AcpCompatDiagnostic[];
  readonly transport: AcpCompatTransportHandlers;
  cancelTurn(turnId: string, reason?: string): number;
  cancelSession(sessionKey: string, reason?: string): number;
  dispose(reason?: string): void;
}

export type AcpCompatFacade = AcpRuntime & {
  readonly [ACPX_COMPAT_FACADE]: typeof ACPX_COMPAT_CONTRACT_VERSION;
  readonly compatibility: AcpCompatSurface;
};

export type AcpCompatFacadeOptions = AcpCompatBrokerOptions & {
  serverId: string;
  transportHooksInstalled?: boolean;
  resolveTurnContext?: (
    input: AcpRuntimeTurnInput,
  ) => Partial<AcpCompatRouteContext>;
};

export function createAcpCompatFacade(
  runtime: AcpRuntime,
  options: AcpCompatFacadeOptions,
): AcpCompatFacade {
  const broker = new AcpCompatBroker(options);
  const report = createAcpxCompatibilityReport(
    options.transportHooksInstalled === true,
  );
  const contextForTurn = (
    input: AcpRuntimeTurnInput,
  ): AcpCompatRouteContext => ({
    serverId: options.serverId,
    sessionKey: input.handle.sessionKey,
    ...(input.handle.backendSessionId === undefined
      ? {}
      : { backendSessionId: input.handle.backendSessionId }),
    requestId: input.requestId,
    ...options.resolveTurnContext?.(input),
  });
  const transport: AcpCompatTransportHandlers = {
    observeRawMessage: (input) => broker.observeRawMessage(input),
    createElicitation: (request, context, requestOptions) =>
      broker.handleElicitation(request, context, requestOptions),
    completeElicitation: (notification, context) =>
      broker.observeElicitationCompleted(notification, context),
    reverseRequest: (method, params, context, requestOptions) =>
      broker.handleReverseRequest(method, params, context, requestOptions),
    reverseNotification: (method, params, context) =>
      broker.observeReverseNotification(method, params, context),
    authMetadata: (observation, context) =>
      broker.observeAuthMetadata(observation, context),
    sessionUpdate: (notification, context) =>
      broker.observeSessionUpdate(notification, context),
  };
  const compatibility: AcpCompatSurface = {
    version: ACPX_COMPAT_CONTRACT_VERSION,
    broker,
    capabilities: report.capabilities,
    diagnostics: report.diagnostics,
    transport,
    cancelTurn: (turnId, reason) =>
      broker.cancelWhere(
        (context) => context.turnId === turnId,
        reason ?? `ACP turn ${turnId} cancelled`,
      ),
    cancelSession: (sessionKey, reason) =>
      broker.cancelWhere(
        (context) => context.sessionKey === sessionKey,
        reason ?? `ACP session ${sessionKey} cancelled`,
      ),
    dispose: (reason) => broker.dispose(reason),
  };

  const facade: AcpRuntime & Record<PropertyKey, unknown> = {
    ensureSession: (input) => runtime.ensureSession(input),
    startTurn: (input) =>
      wrapTurn(runtime.startTurn(input), broker, contextForTurn(input)),
    runTurn: (input) =>
      observeEvents(runtime.runTurn(input), broker, contextForTurn(input)),
    cancel: (input) => runtime.cancel(input),
    close: (input) => runtime.close(input),
    [ACPX_COMPAT_FACADE]: ACPX_COMPAT_CONTRACT_VERSION,
    compatibility,
  };
  const getCapabilities = runtime.getCapabilities?.bind(runtime);
  if (getCapabilities !== undefined) {
    facade.getCapabilities = (input) => getCapabilities(input);
  }
  const getStatus = runtime.getStatus?.bind(runtime);
  if (getStatus !== undefined) facade.getStatus = (input) => getStatus(input);
  const setMode = runtime.setMode?.bind(runtime);
  if (setMode !== undefined) facade.setMode = (input) => setMode(input);
  const setConfigOption = runtime.setConfigOption?.bind(runtime);
  if (setConfigOption !== undefined) {
    facade.setConfigOption = (input) => setConfigOption(input);
  }
  const doctor = runtime.doctor?.bind(runtime);
  if (doctor !== undefined) facade.doctor = () => doctor();
  return facade as unknown as AcpCompatFacade;
}

export function isAcpCompatFacade(value: unknown): value is AcpCompatFacade {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    candidate[ACPX_COMPAT_FACADE] === ACPX_COMPAT_CONTRACT_VERSION &&
    typeof candidate.compatibility === "object" &&
    candidate.compatibility !== null
  );
}

export function createAcpxCompatibilityReport(
  transportHooksInstalled: boolean,
): {
  capabilities: AcpCompatCapabilities;
  diagnostics: readonly AcpCompatDiagnostic[];
} {
  if (transportHooksInstalled) {
    return {
      capabilities: mapCapabilities(
        "available",
        "transport-hook",
        "Installed on the ACP transport",
      ),
      diagnostics: [],
    };
  }

  return {
    capabilities: {
      rawMessages: unavailable(
        "Stock Acpx 0.13.0 does not expose its JSON-RPC stream through the public runtime API",
      ),
      standardElicitation: unavailable(
        "Stock Acpx 0.13.0 does not register the ACP 1.3 elicitation/create client handler",
      ),
      reverseExtensionRequests: unavailable(
        "Stock Acpx 0.13.0 answers arbitrary reverse requests before the public runtime can observe them",
      ),
      reverseExtensionNotifications: unavailable(
        "Stock Acpx 0.13.0 discards arbitrary reverse notifications in its private client",
      ),
      authMetadata: unavailable(
        "Stock Acpx 0.13.0 does not surface initialise/authenticate metadata through AcpRuntime",
      ),
      commandUpdates: degraded(
        "Stock Acpx preserves command names and descriptions but drops the full ACP input schema",
      ),
      configUpdates: degraded(
        "Stock Acpx emits only a status summary for config, mode, and session-info updates",
      ),
    },
    diagnostics: STOCK_ACPX_DIAGNOSTICS,
  };
}

const STOCK_ACPX_DIAGNOSTICS: readonly AcpCompatDiagnostic[] = [
  stockDiagnostic(
    "STOCK_ACPX_RAW_MESSAGES_UNAVAILABLE",
    "Raw ACP messages require a transport hook that the Acpx 0.13.0 public runtime does not provide",
  ),
  stockDiagnostic(
    "STOCK_ACPX_ELICITATION_UNAVAILABLE",
    "Standard ACP elicitation is callable through the compatibility transport contract but unreachable through stock Acpx",
  ),
  stockDiagnostic(
    "STOCK_ACPX_REVERSE_REQUESTS_UNAVAILABLE",
    "Reverse extension requests, including Cursor questions and plan approval, require a transport hook",
  ),
  stockDiagnostic(
    "STOCK_ACPX_REVERSE_NOTIFICATIONS_UNAVAILABLE",
    "Reverse extension notifications require a transport hook",
  ),
  stockDiagnostic(
    "STOCK_ACPX_AUTH_METADATA_UNAVAILABLE",
    "Authentication metadata requires initialise/authenticate observation below the stock runtime API",
  ),
  stockDiagnostic(
    "STOCK_ACPX_COMMAND_SCHEMA_REDUCED",
    "Stock Acpx drops AvailableCommand.input and older persisted sessions may also lack descriptions",
  ),
  stockDiagnostic(
    "STOCK_ACPX_CONFIG_SCHEMA_REDUCED",
    "Stock Acpx does not include SessionConfigOption payloads in runtime events",
  ),
];

function wrapTurn(
  turn: AcpRuntimeTurn,
  broker: AcpCompatBroker,
  context: AcpCompatRouteContext,
): AcpRuntimeTurn {
  return {
    requestId: turn.requestId,
    events: observeEvents(turn.events, broker, context),
    result: turn.result,
    cancel: (input) => turn.cancel(input),
    closeStream: (input) => turn.closeStream(input),
  };
}

async function* observeEvents(
  events: AsyncIterable<AcpRuntimeEvent>,
  broker: AcpCompatBroker,
  context: AcpCompatRouteContext,
): AsyncIterable<AcpRuntimeEvent> {
  for await (const event of events) {
    await broker.observeRuntimeEvent(event, context);
    yield event;
  }
}

function unavailable(detail: string) {
  return {
    availability: "unavailable",
    source: "stock-acpx-public-api",
    detail,
  } as const;
}

function degraded(detail: string) {
  return {
    availability: "degraded",
    source: "stock-acpx-public-api",
    detail,
  } as const;
}

function mapCapabilities(
  availability: "available",
  source: "transport-hook",
  detail: string,
): AcpCompatCapabilities {
  return {
    rawMessages: { availability, source, detail },
    standardElicitation: { availability, source, detail },
    reverseExtensionRequests: { availability, source, detail },
    reverseExtensionNotifications: { availability, source, detail },
    authMetadata: { availability, source, detail },
    commandUpdates: { availability, source, detail },
    configUpdates: { availability, source, detail },
  };
}

function stockDiagnostic(
  code: AcpCompatDiagnostic["code"],
  message: string,
): AcpCompatDiagnostic {
  return { code, severity: "warning", message };
}
