import type { AgentCommand } from "../presets.js";

export type DiagnosticCode =
  | "ACP_EXECUTABLE_MISSING"
  | "ACP_COMMAND_PROBE_FAILED"
  | "ACP_ADAPTER_VERSION_MISMATCH"
  | "ACP_RUNTIME_VERSION_UNSUPPORTED"
  | "ACP_RUNTIME_VERSION_UNTESTED"
  | "ACP_RUNTIME_FEATURE_MISSING"
  | "ACP_INITIALISE_FAILED"
  | "ACP_PROTOCOL_MISMATCH"
  | "ACP_AUTH_REQUIRED"
  | "ACP_AUTH_FAILED"
  | "ACP_MODEL_DISCOVERY_EMPTY"
  | "ACP_MODE_DISCOVERY_EMPTY"
  | "ACP_CLIENT_CAPABILITY_MISSING"
  | "ACP_INITIALISE_METADATA_MISSING"
  | "ACP_REVERSE_METHOD_UNHANDLED"
  | "ACP_MCP_CAPABILITY_MISMATCH"
  | "ACP_SESSION_CREATE_FAILED"
  | "ACP_NATIVE_CHECK_FAILED";

export type DiagnosticLevel = "fatal" | "action" | "warning" | "info";

export interface PresetDiagnostic {
  code: DiagnosticCode;
  level: DiagnosticLevel;
  message: string;
  remediation?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface CommandProbe {
  status: "resolved" | "missing" | "failed";
  command?: AgentCommand;
  executablePath?: string;
  error?: string;
}

export interface VersionProbe {
  status: "supported" | "unsupported" | "untested";
  actual?: string;
}

export interface InitialiseProbe {
  status: "ok" | "failed";
  protocolVersion?: number;
  /** Normalised dot paths whose values were present and truthy. */
  capabilityPaths?: string[];
  /** Normalised paths present in the top-level initialise `_meta`. */
  metadataPaths?: string[];
  error?: string;
}

export interface AuthProbe {
  status: "ready" | "required" | "failed";
  methodIds?: string[];
  error?: string;
}

export interface SessionProbe {
  status: "ok" | "failed";
  modelCount?: number;
  modeCount?: number;
  commandCount?: number;
  error?: string;
}

export interface NativeCheckProbe {
  command: AgentCommand;
  status: "ok" | "failed" | "unavailable";
  error?: string;
}

export interface PresetProbeSnapshot {
  command?: CommandProbe;
  version?: VersionProbe;
  initialise?: InitialiseProbe;
  auth?: AuthProbe;
  session?: SessionProbe;
  /** Normalised dot paths the plugin actually advertised to the agent. */
  clientCapabilityPaths?: string[];
  unhandledReverseMethods?: string[];
  requestedMcpServerCount?: number;
  nativeChecks?: NativeCheckProbe[];
}

export interface DiagnosticSummary {
  ok: boolean;
  highestLevel?: DiagnosticLevel;
  counts: Record<DiagnosticLevel, number>;
}
