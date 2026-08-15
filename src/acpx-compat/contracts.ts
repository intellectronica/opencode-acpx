import type {
  AnyMessage,
  AuthMethod,
  AvailableCommand,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  SessionConfigOption,
  SessionInfoUpdate,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpRuntimeAvailableCommand, AcpRuntimeEvent } from "acpx/runtime";

export const ACPX_COMPAT_CONTRACT_VERSION = 1 as const;

export type AcpCompatFeature =
  | "rawMessages"
  | "standardElicitation"
  | "reverseExtensionRequests"
  | "reverseExtensionNotifications"
  | "authMetadata"
  | "commandUpdates"
  | "configUpdates";

export type AcpCompatAvailability = "available" | "degraded" | "unavailable";

export interface AcpCompatCapability {
  availability: AcpCompatAvailability;
  source: "compat-broker" | "stock-acpx-public-api" | "transport-hook";
  detail: string;
}

export type AcpCompatCapabilities = Readonly<
  Record<AcpCompatFeature, AcpCompatCapability>
>;

export interface AcpCompatRouteContext {
  serverId: string;
  sessionKey?: string;
  backendSessionId?: string;
  turnId?: string;
  requestId?: string;
  rpcId?: string | number | null;
}

export type AcpCompatInvocationContext = AcpCompatRouteContext & {
  interactionId: string;
  sequence: number;
  receivedAt: number;
  signal: AbortSignal;
};

export type AcpCompatDiagnosticCode =
  | "STOCK_ACPX_RAW_MESSAGES_UNAVAILABLE"
  | "STOCK_ACPX_ELICITATION_UNAVAILABLE"
  | "STOCK_ACPX_REVERSE_REQUESTS_UNAVAILABLE"
  | "STOCK_ACPX_REVERSE_NOTIFICATIONS_UNAVAILABLE"
  | "STOCK_ACPX_AUTH_METADATA_UNAVAILABLE"
  | "STOCK_ACPX_COMMAND_SCHEMA_REDUCED"
  | "STOCK_ACPX_CONFIG_SCHEMA_REDUCED"
  | "UNSUPPORTED_ELICITATION"
  | "UNSUPPORTED_REVERSE_REQUEST"
  | "UNHANDLED_REVERSE_NOTIFICATION"
  | "MALFORMED_REVERSE_REQUEST"
  | "INTERACTION_ABORTED"
  | "INTERACTION_TIMED_OUT"
  | "CALLBACK_FAILED";

export interface AcpCompatDiagnostic {
  code: AcpCompatDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  context?: AcpCompatRouteContext;
  method?: string;
  interactionId?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface AcpCompatRawMessage {
  direction: "client-to-agent" | "agent-to-client";
  message: AnyMessage;
  observedAt: number;
  sequence: number;
  context: AcpCompatRouteContext;
}

export interface AcpCompatElicitation {
  request: CreateElicitationRequest;
  context: AcpCompatInvocationContext;
}

export interface AcpCompatElicitationCompleted {
  notification: CompleteElicitationNotification;
  context: AcpCompatRouteContext;
}

export interface AcpCompatReverseRequest {
  method: string;
  params: unknown;
  context: AcpCompatInvocationContext;
}

export interface AcpCompatReverseNotification {
  method: string;
  params: unknown;
  context: AcpCompatRouteContext & {
    observedAt: number;
    sequence: number;
  };
}

export interface CursorQuestionOption {
  id: string;
  label: string;
}

export interface CursorQuestion {
  id: string;
  prompt: string;
  options: CursorQuestionOption[];
  allowMultiple?: boolean;
}

export interface CursorAskQuestionRequest {
  toolCallId: string;
  title?: string;
  questions: CursorQuestion[];
}

export interface CursorAskQuestionResponse {
  outcome:
    | {
        outcome: "answered";
        answers: { questionId: string; selectedOptionIds: string[] }[];
      }
    | { outcome: "skipped"; reason?: string }
    | { outcome: "cancelled" };
}

export type CursorTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface CursorTodo {
  id: string;
  content: string;
  status: CursorTodoStatus;
}

export interface CursorPlanPhase {
  name: string;
  todos: CursorTodo[];
}

export interface CursorCreatePlanRequest {
  toolCallId: string;
  name?: string;
  overview?: string;
  plan: string;
  todos: CursorTodo[];
  isProject?: boolean;
  phases?: CursorPlanPhase[];
}

export interface CursorCreatePlanResponse {
  outcome:
    | { outcome: "accepted"; planUri?: string }
    | { outcome: "rejected"; reason?: string }
    | { outcome: "cancelled" };
}

export interface AcpCompatCursorQuestion {
  method: "cursor/ask_question";
  request: CursorAskQuestionRequest;
  rawParams: unknown;
  context: AcpCompatInvocationContext;
}

export interface AcpCompatCursorPlan {
  method: "cursor/create_plan";
  request: CursorCreatePlanRequest;
  rawParams: unknown;
  context: AcpCompatInvocationContext;
}

export interface AcpCompatAuthMethod {
  id: string;
  name: string;
  type: "agent" | "env_var" | "terminal";
  description?: string;
  variableNames?: string[];
  secretVariableNames?: string[];
  optionalVariableNames?: string[];
  link?: string;
  arguments?: string[];
  environmentNames?: string[];
}

export interface AcpCompatAuthMetadata {
  status: "advertised" | "selected" | "authenticated" | "failed";
  methods: AcpCompatAuthMethod[];
  selectedMethodId?: string;
  failureMessage?: string;
  observedAt: number;
  sequence: number;
  context: AcpCompatRouteContext;
}

export type AcpCompatCommandUpdate =
  | {
      commands: AvailableCommand[];
      fidelity: "full";
      source: "protocol";
      context: AcpCompatRouteContext;
      raw: SessionNotification;
    }
  | {
      commands: AcpRuntimeAvailableCommand[];
      fidelity: "reduced";
      source: "stock-runtime";
      context: AcpCompatRouteContext;
      raw: AcpRuntimeEvent;
    };

export type AcpCompatConfigUpdate =
  | {
      configOptions: SessionConfigOption[];
      fidelity: "full";
      source: "protocol";
      context: AcpCompatRouteContext;
      raw: SessionNotification;
    }
  | {
      fidelity: "reduced";
      source: "stock-runtime";
      context: AcpCompatRouteContext;
      raw: AcpRuntimeEvent;
    };

export interface AcpCompatModeUpdate {
  currentModeId?: string;
  fidelity: "full" | "reduced";
  source: "protocol" | "stock-runtime";
  context: AcpCompatRouteContext;
  raw: SessionNotification | AcpRuntimeEvent;
}

export interface AcpCompatSessionInfoUpdate {
  update?: SessionInfoUpdate;
  fidelity: "full" | "reduced";
  source: "protocol" | "stock-runtime";
  context: AcpCompatRouteContext;
  raw: SessionNotification | AcpRuntimeEvent;
}

export interface AcpCompatCallbacks {
  onRawMessage?: (message: AcpCompatRawMessage) => void | Promise<void>;
  onElicitation?: (
    elicitation: AcpCompatElicitation,
  ) => CreateElicitationResponse | Promise<CreateElicitationResponse>;
  onElicitationCompleted?: (
    event: AcpCompatElicitationCompleted,
  ) => void | Promise<void>;
  onReverseRequest?: (request: AcpCompatReverseRequest) => unknown;
  onReverseNotification?: (
    notification: AcpCompatReverseNotification,
  ) => void | Promise<void>;
  onCursorQuestion?: (
    request: AcpCompatCursorQuestion,
  ) => CursorAskQuestionResponse | Promise<CursorAskQuestionResponse>;
  onCursorPlan?: (
    request: AcpCompatCursorPlan,
  ) => CursorCreatePlanResponse | Promise<CursorCreatePlanResponse>;
  onAuthMetadata?: (metadata: AcpCompatAuthMetadata) => void | Promise<void>;
  onSessionUpdate?: (notification: SessionNotification) => void | Promise<void>;
  onCommandUpdate?: (update: AcpCompatCommandUpdate) => void | Promise<void>;
  onConfigUpdate?: (update: AcpCompatConfigUpdate) => void | Promise<void>;
  onModeUpdate?: (update: AcpCompatModeUpdate) => void | Promise<void>;
  onSessionInfoUpdate?: (
    update: AcpCompatSessionInfoUpdate,
  ) => void | Promise<void>;
  onDiagnostic?: (diagnostic: AcpCompatDiagnostic) => void | Promise<void>;
}

export interface AcpCompatAuthObservation {
  status: AcpCompatAuthMetadata["status"];
  methods: AuthMethod[];
  selectedMethodId?: string;
  failureMessage?: string;
}

export interface AcpCompatRawMessageInput {
  direction: AcpCompatRawMessage["direction"];
  message: AnyMessage;
  context: AcpCompatRouteContext;
}
