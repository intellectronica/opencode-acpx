import type { Preset } from "../presets.js";
import type {
  DiagnosticLevel,
  DiagnosticSummary,
  PresetDiagnostic,
  PresetProbeSnapshot,
} from "./types.js";

const levelRank: Record<DiagnosticLevel, number> = {
  info: 0,
  warning: 1,
  action: 2,
  fatal: 3,
};

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function commandText(command: { command: string; args: string[] }): string {
  return [command.command, ...command.args].join(" ");
}

export function diagnosePreset(
  preset: Preset,
  snapshot: PresetProbeSnapshot,
): PresetDiagnostic[] {
  const diagnostics: PresetDiagnostic[] = [];
  const command = snapshot.command;
  if (command?.status === "missing") {
    diagnostics.push({
      code: "ACP_EXECUTABLE_MISSING",
      level: "fatal",
      message: `No executable could be resolved for ${preset.title}.`,
      remediation: preset.installHint,
      details: { candidates: [preset.command, ...preset.fallbacks] },
    });
  } else if (command?.status === "failed") {
    diagnostics.push({
      code: "ACP_COMMAND_PROBE_FAILED",
      level: "fatal",
      message: `${preset.title}'s command probe failed.`,
      remediation: preset.installHint,
      details: {
        command: command.command ?? preset.version.probe,
        ...(command.error === undefined ? {} : { error: command.error }),
      },
    });
  }

  const version = snapshot.version;
  if (version?.status === "unsupported") {
    const versionPolicy = preset.version;
    diagnostics.push({
      code:
        versionPolicy.kind === "npm-exact"
          ? "ACP_ADAPTER_VERSION_MISMATCH"
          : "ACP_RUNTIME_VERSION_UNSUPPORTED",
      level: "fatal",
      message:
        versionPolicy.kind === "npm-exact"
          ? `${preset.title} must use ${versionPolicy.package}@${versionPolicy.version}.`
          : `${preset.title} does not satisfy the tested runtime contract.`,
      remediation: `Run ${commandText(versionPolicy.probe)} and verify the configured executable.`,
      details: {
        ...(version.actual === undefined ? {} : { actual: version.actual }),
        expected:
          versionPolicy.kind === "npm-exact"
            ? versionPolicy.version
            : (versionPolicy.minimumVersion ?? versionPolicy.testedVersion),
      },
    });
  } else if (version?.status === "untested") {
    diagnostics.push({
      code: "ACP_RUNTIME_VERSION_UNTESTED",
      level: "warning",
      message: `${preset.title} is newer than the contract tested by this plugin.`,
      remediation:
        "Run the feature and real-agent probes before relying on this runtime version.",
      details: {
        ...(version.actual === undefined ? {} : { actual: version.actual }),
        tested:
          preset.version.kind === "npm-exact"
            ? preset.version.version
            : preset.version.testedVersion,
      },
    });
  }

  const initialise = snapshot.initialise;
  if (initialise?.status === "failed") {
    diagnostics.push({
      code: "ACP_INITIALISE_FAILED",
      level: "fatal",
      message: `${preset.title} did not complete the ACP initialise handshake.`,
      ...(initialise.error === undefined
        ? {}
        : { details: { error: initialise.error } }),
    });
  } else if (initialise?.status === "ok") {
    if (initialise.protocolVersion !== preset.capabilities.protocolVersion) {
      diagnostics.push({
        code: "ACP_PROTOCOL_MISMATCH",
        level: "fatal",
        message: `${preset.title} returned ACP protocol version ${String(initialise.protocolVersion)}; version ${String(preset.capabilities.protocolVersion)} is required.`,
        details: {
          actual: initialise.protocolVersion,
          expected: preset.capabilities.protocolVersion,
        },
      });
    }

    const capabilities = new Set(initialise.capabilityPaths ?? []);
    const missingCapabilities = preset.capabilities.requiredPaths.filter(
      (path) => !capabilities.has(path),
    );
    if (missingCapabilities.length > 0) {
      diagnostics.push({
        code: "ACP_RUNTIME_FEATURE_MISSING",
        level: "fatal",
        message: `${preset.title} is missing required ACP capabilities.`,
        remediation:
          "Use a supported runtime build or choose a custom server contract.",
        details: { missing: missingCapabilities },
      });
    }

    const metadata = new Set(initialise.metadataPaths ?? []);
    const missingMetadata =
      preset.diagnostics.requiredInitialiseMetadata.filter(
        (path) => !metadata.has(path),
      );
    if (missingMetadata.length > 0) {
      diagnostics.push({
        code: "ACP_INITIALISE_METADATA_MISSING",
        level: "warning",
        message: `${preset.title} omitted metadata used for complete discovery.`,
        remediation:
          "Continue with standard ACP discovery and report the runtime version.",
        details: { missing: missingMetadata },
      });
    }
  }

  if (snapshot.clientCapabilityPaths !== undefined) {
    const clientCapabilities = new Set(snapshot.clientCapabilityPaths);
    const missingClientCapabilities =
      preset.capabilities.requiredClientPaths.filter(
        (path) => !clientCapabilities.has(path),
      );
    if (missingClientCapabilities.length > 0) {
      diagnostics.push({
        code: "ACP_CLIENT_CAPABILITY_MISSING",
        level: "warning",
        message: `The plugin cannot expose every ${preset.title} interaction.`,
        remediation:
          "Enable the matching plugin interaction handler before advertising the capability.",
        details: { missing: missingClientCapabilities },
      });
    }
  }

  const auth = snapshot.auth;
  if (auth?.status === "required") {
    diagnostics.push({
      code: "ACP_AUTH_REQUIRED",
      level: "action",
      message: `${preset.title} requires authentication.`,
      remediation: preset.installHint,
      details: { methodIds: sortedUnique(auth.methodIds) },
    });
  } else if (auth?.status === "failed") {
    diagnostics.push({
      code: "ACP_AUTH_FAILED",
      level: "fatal",
      message: `${preset.title} authentication failed.`,
      remediation: preset.installHint,
      details: {
        methodIds: sortedUnique(auth.methodIds),
        ...(auth.error === undefined ? {} : { error: auth.error }),
      },
    });
  }

  const session = snapshot.session;
  if (session?.status === "failed") {
    diagnostics.push({
      code: "ACP_SESSION_CREATE_FAILED",
      level: "fatal",
      message: `${preset.title} could not create a probe session.`,
      ...(session.error === undefined
        ? {}
        : { details: { error: session.error } }),
    });
  } else if (session?.status === "ok") {
    if (session.modelCount === 0) {
      diagnostics.push({
        code: "ACP_MODEL_DISCOVERY_EMPTY",
        level: "action",
        message: `${preset.title} returned no usable models.`,
        remediation:
          "Check authentication, account entitlements and the selected native profile.",
      });
    }
    if (session.modeCount === 0) {
      diagnostics.push({
        code: "ACP_MODE_DISCOVERY_EMPTY",
        level: "warning",
        message: `${preset.title} returned no session modes.`,
        remediation:
          "Use the agent default and disable mode selection for this runtime.",
      });
    }
  }

  const unhandledMethods = sortedUnique(snapshot.unhandledReverseMethods);
  if (unhandledMethods.length > 0) {
    diagnostics.push({
      code: "ACP_REVERSE_METHOD_UNHANDLED",
      level: "warning",
      message: `${preset.title} requested reverse ACP methods that the plugin did not handle.`,
      remediation:
        "Reject the interaction safely and add a typed plugin handler before advertising support.",
      details: { methods: unhandledMethods },
    });
  }

  if (
    preset.mcp.knownAdvertisementMismatch &&
    (snapshot.requestedMcpServerCount ?? 0) > 0
  ) {
    diagnostics.push({
      code: "ACP_MCP_CAPABILITY_MISMATCH",
      level: "warning",
      message: `${preset.title} accepts session MCP servers without advertising mcpCapabilities.`,
      remediation:
        "Pass explicitly configured MCP servers only and verify them in a probe session.",
      details: { requested: snapshot.requestedMcpServerCount },
    });
  }

  for (const check of snapshot.nativeChecks ?? []) {
    if (check.status === "ok") continue;
    diagnostics.push({
      code: "ACP_NATIVE_CHECK_FAILED",
      level: check.status === "unavailable" ? "warning" : "fatal",
      message: `${preset.title} native check failed: ${commandText(check.command)}.`,
      ...(check.error === undefined ? {} : { details: { error: check.error } }),
    });
  }

  return diagnostics;
}

export function summariseDiagnostics(
  diagnostics: readonly PresetDiagnostic[],
): DiagnosticSummary {
  const counts: DiagnosticSummary["counts"] = {
    fatal: 0,
    action: 0,
    warning: 0,
    info: 0,
  };
  let highestLevel: DiagnosticLevel | undefined;
  for (const diagnostic of diagnostics) {
    counts[diagnostic.level] += 1;
    if (
      highestLevel === undefined ||
      levelRank[diagnostic.level] > levelRank[highestLevel]
    ) {
      highestLevel = diagnostic.level;
    }
  }
  return {
    ok: counts.fatal === 0 && counts.action === 0,
    ...(highestLevel === undefined ? {} : { highestLevel }),
    counts,
  };
}
