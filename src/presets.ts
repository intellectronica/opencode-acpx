import type { PresetId, ServerConfig } from "./config.js";

export interface AgentCommand {
  command: string;
  args: string[];
}

export type PresetVersionPolicy =
  | {
      kind: "npm-exact";
      package: string;
      version: string;
      node: string;
      probe: AgentCommand;
    }
  | {
      kind: "system-feature-probe";
      testedVersion: string;
      minimumVersion?: string;
      probe: AgentCommand;
      featureProbes: AgentCommand[];
    };

export type DiscoverySource =
  | { kind: "config-option"; id: string }
  | { kind: "legacy-model-state" }
  | { kind: "legacy-mode-state" }
  | { kind: "initialise-meta"; path: string }
  | { kind: "session-meta"; path: string }
  | { kind: "session-update"; update: string }
  | { kind: "native-command"; command: AgentCommand; supplemental: true }
  | { kind: "agent-native"; detail: string };

export type ControlMethod =
  | { kind: "config-option"; id: string }
  | { kind: "session-method"; method: string }
  | { kind: "session-meta"; path: string };

export interface PresetDiscovery {
  models: DiscoverySource[];
  modes: DiscoverySource[];
  commands: DiscoverySource[];
  skills: DiscoverySource[];
  preserveOpaqueIds: true;
}

export interface PresetControls {
  model: ControlMethod[];
  mode: ControlMethod[];
  config: ControlMethod[];
}

export interface PresetAuth {
  ownership: "agent-native";
  methodIds: string[];
  dynamicMethods: boolean;
  preflight: AgentCommand[];
  recognisedEnvironment: string[];
  secretEnvironment: string[];
}

export type CapabilitySupport =
  | "required"
  | "optional"
  | "unsupported"
  | "known-unadvertised";

export interface PresetCapabilities {
  protocolVersion: 1;
  prompt: {
    image: CapabilitySupport;
    audio: CapabilitySupport;
    embeddedContext: CapabilitySupport;
  };
  mcp: {
    stdio: CapabilitySupport;
    http: CapabilitySupport;
    sse: CapabilitySupport;
  };
  sessions: {
    load: CapabilitySupport;
    list: CapabilitySupport;
    resume: CapabilitySupport;
    fork: CapabilitySupport;
    close: CapabilitySupport;
    delete: CapabilitySupport;
    additionalDirectories: CapabilitySupport;
  };
  requiredPaths: string[];
  optionalPaths: string[];
  requiredClientPaths: string[];
}

export interface PresetExtensions {
  clientToAgent: string[];
  agentToClient: string[];
  unknownReverseMethods: "reject" | "route-to-plugin";
}

export interface PresetMcp {
  nativeConfig: string[];
  sessionServers: "merge-and-dedupe" | "pass-through";
  knownAdvertisementMismatch: boolean;
}

export interface PresetDiagnosticContract {
  nativeChecks: AgentCommand[];
  requiredInitialiseMetadata: string[];
  knownLimitations: string[];
}

export interface Preset {
  id: Exclude<PresetId, "custom">;
  title: string;
  command: AgentCommand;
  fallbacks: AgentCommand[];
  processIsolation: "session" | "profile";
  supportsLegacyModels: boolean;
  nativeSkillRoots: string[];
  installHint: string;
  version: PresetVersionPolicy;
  discovery: PresetDiscovery;
  controls: PresetControls;
  auth: PresetAuth;
  capabilities: PresetCapabilities;
  extensions: PresetExtensions;
  mcp: PresetMcp;
  diagnostics: PresetDiagnosticContract;
}

const availableCommands: DiscoverySource = {
  kind: "session-update",
  update: "available_commands_update",
};
const legacyModels: DiscoverySource = { kind: "legacy-model-state" };
const legacyModes: DiscoverySource = { kind: "legacy-mode-state" };
const legacyModelControl: ControlMethod = {
  kind: "session-method",
  method: "session/set_model",
};
const standardModeControl: ControlMethod = {
  kind: "session-method",
  method: "session/set_mode",
};

export const PRESETS: Record<Exclude<PresetId, "custom">, Preset> = {
  cursor: {
    id: "cursor",
    title: "Cursor Agent",
    command: { command: "cursor-agent", args: ["acp"] },
    fallbacks: [{ command: "agent", args: ["acp"] }],
    processIsolation: "session",
    supportsLegacyModels: true,
    nativeSkillRoots: [".agents/skills", ".cursor/skills", "~/.cursor/skills"],
    installHint: "Install Cursor Agent and run `cursor-agent login`.",
    version: {
      kind: "system-feature-probe",
      testedVersion: "2026.08.11-e8db854",
      probe: { command: "cursor-agent", args: ["--version"] },
      featureProbes: [
        { command: "cursor-agent", args: ["acp", "--help"] },
        {
          command: "cursor-agent",
          args: ["status", "--format", "json"],
        },
      ],
    },
    discovery: {
      models: [{ kind: "config-option", id: "model" }, legacyModels],
      modes: [{ kind: "config-option", id: "mode" }, legacyModes],
      commands: [availableCommands],
      skills: [
        availableCommands,
        {
          kind: "agent-native",
          detail:
            "Cursor rules, commands and skills are loaded natively; ACP does not guarantee a complete catalogue.",
        },
      ],
      preserveOpaqueIds: true,
    },
    controls: {
      model: [{ kind: "config-option", id: "model" }, legacyModelControl],
      mode: [{ kind: "config-option", id: "mode" }, standardModeControl],
      config: [
        { kind: "config-option", id: "model" },
        { kind: "config-option", id: "mode" },
      ],
    },
    auth: {
      ownership: "agent-native",
      methodIds: ["cursor_login"],
      dynamicMethods: false,
      preflight: [
        { command: "cursor-agent", args: ["status", "--format", "json"] },
      ],
      recognisedEnvironment: ["CURSOR_API_KEY", "CURSOR_API_ENDPOINT"],
      secretEnvironment: ["CURSOR_API_KEY"],
    },
    capabilities: {
      protocolVersion: 1,
      prompt: {
        image: "required",
        audio: "unsupported",
        embeddedContext: "unsupported",
      },
      mcp: { stdio: "required", http: "required", sse: "required" },
      sessions: {
        load: "required",
        list: "required",
        resume: "unsupported",
        fork: "unsupported",
        close: "unsupported",
        delete: "unsupported",
        additionalDirectories: "unsupported",
      },
      requiredPaths: [
        "agentCapabilities.loadSession",
        "agentCapabilities.promptCapabilities.image",
        "agentCapabilities.sessionCapabilities.list",
      ],
      optionalPaths: [
        "agentCapabilities.mcpCapabilities.http",
        "agentCapabilities.mcpCapabilities.sse",
      ],
      requiredClientPaths: [],
    },
    extensions: {
      clientToAgent: [],
      agentToClient: ["cursor/ask_question", "cursor/create_plan"],
      unknownReverseMethods: "route-to-plugin",
    },
    mcp: {
      nativeConfig: ["~/.cursor/mcp.json", ".cursor/mcp.json"],
      sessionServers: "merge-and-dedupe",
      knownAdvertisementMismatch: false,
    },
    diagnostics: {
      nativeChecks: [
        { command: "cursor-agent", args: ["status", "--format", "json"] },
        { command: "cursor-agent", args: ["models"] },
      ],
      requiredInitialiseMetadata: [],
      knownLimitations: [
        "Cursor's reverse interaction methods are not declared during initialise and may change between beta builds.",
        "Cursor does not guarantee a complete ACP skill or command catalogue.",
      ],
    },
  },
  claude: {
    id: "claude",
    title: "Claude Agent ACP",
    command: {
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
    },
    fallbacks: [],
    processIsolation: "profile",
    supportsLegacyModels: false,
    nativeSkillRoots: [".agents/skills", ".claude/skills", "~/.claude/skills"],
    installHint:
      "Authenticate Claude Code or configure the Claude Agent SDK before use.",
    version: {
      kind: "npm-exact",
      package: "@agentclientprotocol/claude-agent-acp",
      version: "0.68.0",
      node: ">=22",
      probe: {
        command: "npx",
        args: [
          "-y",
          "@agentclientprotocol/claude-agent-acp@0.68.0",
          "--version",
        ],
      },
    },
    discovery: {
      models: [{ kind: "config-option", id: "model" }],
      modes: [{ kind: "config-option", id: "mode" }, legacyModes],
      commands: [availableCommands],
      skills: [availableCommands],
      preserveOpaqueIds: true,
    },
    controls: {
      model: [{ kind: "config-option", id: "model" }],
      mode: [{ kind: "config-option", id: "mode" }, standardModeControl],
      config: [
        { kind: "config-option", id: "model" },
        { kind: "config-option", id: "mode" },
        { kind: "config-option", id: "effort" },
        { kind: "config-option", id: "agent" },
        { kind: "config-option", id: "fast" },
      ],
    },
    auth: {
      ownership: "agent-native",
      methodIds: [
        "claude-ai-login",
        "console-login",
        "claude-login",
        "gateway",
        "gateway-bedrock",
      ],
      dynamicMethods: true,
      preflight: [],
      recognisedEnvironment: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_EXECUTABLE",
        "CLAUDE_MODEL_CONFIG",
        "MAX_THINKING_TOKENS",
        "NO_BROWSER",
        "CLAUDE_CODE_REMOTE",
      ],
      secretEnvironment: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    },
    capabilities: {
      protocolVersion: 1,
      prompt: {
        image: "required",
        audio: "unsupported",
        embeddedContext: "required",
      },
      mcp: { stdio: "required", http: "required", sse: "required" },
      sessions: {
        load: "required",
        list: "required",
        resume: "required",
        fork: "required",
        close: "required",
        delete: "required",
        additionalDirectories: "required",
      },
      requiredPaths: [
        "agentCapabilities.loadSession",
        "agentCapabilities.promptCapabilities.image",
        "agentCapabilities.promptCapabilities.embeddedContext",
        "agentCapabilities.sessionCapabilities.list",
        "agentCapabilities.sessionCapabilities.resume",
        "agentCapabilities.sessionCapabilities.fork",
        "agentCapabilities.sessionCapabilities.close",
        "agentCapabilities.sessionCapabilities.delete",
        "agentCapabilities.sessionCapabilities.additionalDirectories",
      ],
      optionalPaths: [
        "_meta.steering.supported",
        "_meta.claudeCode.promptQueueing",
      ],
      requiredClientPaths: ["elicitation.form"],
    },
    extensions: {
      clientToAgent: ["_session/steering", "session/goal", "providers/*"],
      agentToClient: ["session/create_elicitation"],
      unknownReverseMethods: "route-to-plugin",
    },
    mcp: {
      nativeConfig: ["Claude Code and Claude Agent SDK settings"],
      sessionServers: "merge-and-dedupe",
      knownAdvertisementMismatch: false,
    },
    diagnostics: {
      nativeChecks: [],
      requiredInitialiseMetadata: [],
      knownLimitations: [
        "AskUserQuestion is disabled when the client does not advertise form elicitation.",
        "Device, terminal and gateway auth methods depend on client capabilities and environment.",
      ],
    },
  },
  codex: {
    id: "codex",
    title: "Codex ACP",
    command: {
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@1.3.0"],
    },
    fallbacks: [],
    processIsolation: "profile",
    supportsLegacyModels: false,
    nativeSkillRoots: [".agents/skills", "~/.codex/skills"],
    installHint: "Authenticate the Codex CLI before use.",
    version: {
      kind: "npm-exact",
      package: "@agentclientprotocol/codex-acp",
      version: "1.3.0",
      node: ">=22",
      probe: {
        command: "npx",
        args: ["-y", "@agentclientprotocol/codex-acp@1.3.0", "--version"],
      },
    },
    discovery: {
      models: [{ kind: "config-option", id: "model" }],
      modes: [{ kind: "config-option", id: "mode" }, legacyModes],
      commands: [availableCommands],
      skills: [availableCommands],
      preserveOpaqueIds: true,
    },
    controls: {
      model: [{ kind: "config-option", id: "model" }, legacyModelControl],
      mode: [{ kind: "config-option", id: "mode" }, standardModeControl],
      config: [
        { kind: "config-option", id: "model" },
        { kind: "config-option", id: "mode" },
        { kind: "config-option", id: "reasoning_effort" },
        { kind: "config-option", id: "fast-mode" },
        { kind: "config-option", id: "collaboration_mode" },
      ],
    },
    auth: {
      ownership: "agent-native",
      methodIds: ["api-key", "chat-gpt", "chat-gpt-device-code", "gateway"],
      dynamicMethods: true,
      preflight: [],
      recognisedEnvironment: [
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "CODEX_PATH",
        "CODEX_CONFIG",
        "MODEL_PROVIDER",
        "DEFAULT_AUTH_REQUEST",
        "INITIAL_AGENT_MODE",
        "NO_BROWSER",
        "APP_SERVER_LOGS",
      ],
      secretEnvironment: ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_CONFIG"],
    },
    capabilities: {
      protocolVersion: 1,
      prompt: {
        image: "required",
        audio: "unsupported",
        embeddedContext: "required",
      },
      mcp: { stdio: "required", http: "required", sse: "unsupported" },
      sessions: {
        load: "required",
        list: "required",
        resume: "required",
        fork: "unsupported",
        close: "required",
        delete: "required",
        additionalDirectories: "required",
      },
      requiredPaths: [
        "agentCapabilities.loadSession",
        "agentCapabilities.promptCapabilities.image",
        "agentCapabilities.promptCapabilities.embeddedContext",
        "agentCapabilities.sessionCapabilities.list",
        "agentCapabilities.sessionCapabilities.resume",
        "agentCapabilities.sessionCapabilities.close",
        "agentCapabilities.sessionCapabilities.delete",
        "agentCapabilities.sessionCapabilities.additionalDirectories",
      ],
      optionalPaths: ["_meta.steering.supported"],
      requiredClientPaths: ["elicitation.form"],
    },
    extensions: {
      clientToAgent: [
        "_session/steering",
        "session/goal",
        "providers/*",
        "session/set_model",
      ],
      agentToClient: ["session/create_elicitation"],
      unknownReverseMethods: "route-to-plugin",
    },
    mcp: {
      nativeConfig: ["Codex app-server configuration"],
      sessionServers: "merge-and-dedupe",
      knownAdvertisementMismatch: false,
    },
    diagnostics: {
      nativeChecks: [],
      requiredInitialiseMetadata: [],
      knownLimitations: [
        "ChatGPT device-code authentication is hidden without URL elicitation.",
        "Agent full-access disables approval and sandbox restrictions and must be selected explicitly.",
      ],
    },
  },
  "grok-build": {
    id: "grok-build",
    title: "Grok Build",
    command: { command: "grok", args: ["agent", "--no-leader", "stdio"] },
    fallbacks: [],
    processIsolation: "profile",
    supportsLegacyModels: true,
    nativeSkillRoots: [".agents/skills", ".grok/skills", "~/.grok/skills"],
    installHint:
      "Install Grok Build and run `grok login` or configure XAI_API_KEY.",
    version: {
      kind: "system-feature-probe",
      testedVersion: "1.0.4 (d846eb93d94d) [alpha]",
      minimumVersion: "1.0.4",
      probe: { command: "grok", args: ["--version"] },
      featureProbes: [
        { command: "grok", args: ["agent", "--help"] },
        { command: "grok", args: ["agent", "stdio", "--help"] },
      ],
    },
    discovery: {
      models: [legacyModels, { kind: "initialise-meta", path: "modelState" }],
      modes: [
        legacyModes,
        { kind: "session-meta", path: "x.ai/sessionConfig.options" },
      ],
      commands: [
        { kind: "initialise-meta", path: "availableCommands" },
        availableCommands,
      ],
      skills: [
        { kind: "initialise-meta", path: "availableCommands" },
        availableCommands,
        {
          kind: "native-command",
          command: { command: "grok", args: ["inspect", "--json"] },
          supplemental: true,
        },
      ],
      preserveOpaqueIds: true,
    },
    controls: {
      model: [
        legacyModelControl,
        { kind: "session-meta", path: "reasoningEffort" },
      ],
      mode: [standardModeControl],
      config: [{ kind: "session-meta", path: "x.ai/sessionConfig.options" }],
    },
    auth: {
      ownership: "agent-native",
      methodIds: ["xai.api_key", "cached_token", "grok.com", "oidc"],
      dynamicMethods: true,
      preflight: [],
      recognisedEnvironment: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"],
      secretEnvironment: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"],
    },
    capabilities: {
      protocolVersion: 1,
      prompt: {
        image: "unsupported",
        audio: "unsupported",
        embeddedContext: "required",
      },
      mcp: { stdio: "required", http: "required", sse: "required" },
      sessions: {
        load: "required",
        list: "optional",
        resume: "optional",
        fork: "unsupported",
        close: "required",
        delete: "unsupported",
        additionalDirectories: "unsupported",
      },
      requiredPaths: [
        "agentCapabilities.loadSession",
        "agentCapabilities.promptCapabilities.embeddedContext",
        "agentCapabilities.sessionCapabilities.close",
      ],
      optionalPaths: [
        "agentCapabilities.sessionCapabilities.list",
        "agentCapabilities.sessionCapabilities.resume",
        "agentCapabilities.mcpCapabilities.http",
        "agentCapabilities.mcpCapabilities.sse",
      ],
      requiredClientPaths: [],
    },
    extensions: {
      clientToAgent: ["x.ai/*"],
      agentToClient: ["x.ai/ask_user_question", "x.ai/exit_plan_mode"],
      unknownReverseMethods: "route-to-plugin",
    },
    mcp: {
      nativeConfig: ["~/.grok/config.toml", ".grok/config.toml"],
      sessionServers: "merge-and-dedupe",
      knownAdvertisementMismatch: false,
    },
    diagnostics: {
      nativeChecks: [
        { command: "grok", args: ["inspect", "--json"] },
        { command: "grok", args: ["mcp", "doctor", "--json"] },
      ],
      requiredInitialiseMetadata: [
        "modelState",
        "availableCommands",
        "defaultAuthMethodId",
      ],
      knownLimitations: [
        "Grok Build is alpha and its x.ai extension set is explicitly non-exhaustive.",
        "A shared leader is disabled by the preset to keep ACP processes and profiles isolated.",
      ],
    },
  },
  hermes: {
    id: "hermes",
    title: "Hermes Agent",
    command: { command: "hermes", args: ["acp"] },
    fallbacks: [{ command: "hermes-acp", args: [] }],
    processIsolation: "profile",
    supportsLegacyModels: true,
    nativeSkillRoots: [".agents/skills", "~/.hermes/skills"],
    installHint:
      "Install Hermes with its ACP extra and run `hermes acp --setup`.",
    version: {
      kind: "system-feature-probe",
      testedVersion: "0.20.1 (v2026.8.13)",
      minimumVersion: "0.20.1",
      probe: { command: "hermes", args: ["acp", "--version"] },
      featureProbes: [{ command: "hermes", args: ["acp", "--check"] }],
    },
    discovery: {
      models: [legacyModels],
      modes: [legacyModes],
      commands: [availableCommands],
      skills: [
        {
          kind: "agent-native",
          detail:
            "Hermes skills remain available to the agent but are not advertised individually over ACP.",
        },
      ],
      preserveOpaqueIds: true,
    },
    controls: {
      model: [legacyModelControl],
      mode: [standardModeControl],
      config: [],
    },
    auth: {
      ownership: "agent-native",
      methodIds: ["hermes-setup"],
      dynamicMethods: true,
      preflight: [{ command: "hermes", args: ["acp", "--check"] }],
      recognisedEnvironment: ["HERMES_HOME", "HERMES_ACP_SKIP_CONFIGURED_MCP"],
      secretEnvironment: [],
    },
    capabilities: {
      protocolVersion: 1,
      prompt: {
        image: "required",
        audio: "known-unadvertised",
        embeddedContext: "known-unadvertised",
      },
      mcp: {
        stdio: "known-unadvertised",
        http: "known-unadvertised",
        sse: "known-unadvertised",
      },
      sessions: {
        load: "required",
        list: "required",
        resume: "required",
        fork: "required",
        close: "unsupported",
        delete: "unsupported",
        additionalDirectories: "unsupported",
      },
      requiredPaths: [
        "agentCapabilities.loadSession",
        "agentCapabilities.promptCapabilities.image",
        "agentCapabilities.sessionCapabilities.list",
        "agentCapabilities.sessionCapabilities.resume",
        "agentCapabilities.sessionCapabilities.fork",
      ],
      optionalPaths: [],
      requiredClientPaths: [],
    },
    extensions: {
      clientToAgent: ["session/set_model"],
      agentToClient: [],
      unknownReverseMethods: "reject",
    },
    mcp: {
      nativeConfig: ["~/.hermes/config.yaml"],
      sessionServers: "merge-and-dedupe",
      knownAdvertisementMismatch: true,
    },
    diagnostics: {
      nativeChecks: [{ command: "hermes", args: ["acp", "--check"] }],
      requiredInitialiseMetadata: [],
      knownLimitations: [
        "Hermes accepts session MCP servers but does not advertise mcpCapabilities.",
        "Hermes ACP advertises nine built-in commands, not its individual skills.",
      ],
    },
  },
};

export function resolvePreset(server: ServerConfig): Preset | undefined {
  return server.preset === "custom" ? undefined : PRESETS[server.preset];
}

export function resolveConfiguredCommand(server: ServerConfig): AgentCommand {
  const preset = resolvePreset(server);
  const command = server.command ?? preset?.command.command;
  if (command === undefined)
    throw new Error("Custom ACP servers require a command");
  return { command, args: server.args ?? preset?.command.args ?? [] };
}

export function providerId(serverId: string): string {
  return `acp.${serverId}`;
}
