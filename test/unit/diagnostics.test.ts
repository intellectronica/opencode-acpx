import { describe, expect, it } from "vitest";

import {
  diagnosePreset,
  summariseDiagnostics,
} from "../../src/diagnostics/index.js";
import { PRESETS } from "../../src/presets.js";

describe("diagnosePreset", () => {
  it("reports a missing executable with the preset remediation", () => {
    const diagnostics = diagnosePreset(PRESETS.cursor, {
      command: { status: "missing" },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "ACP_EXECUTABLE_MISSING",
        level: "fatal",
        remediation: PRESETS.cursor.installHint,
      }),
    ]);
  });

  it("distinguishes exact adapter mismatches from untested system versions", () => {
    expect(
      diagnosePreset(PRESETS.claude, {
        version: { status: "unsupported", actual: "0.67.0" },
      }),
    ).toContainEqual(
      expect.objectContaining({
        code: "ACP_ADAPTER_VERSION_MISMATCH",
        level: "fatal",
      }),
    );
    expect(
      diagnosePreset(PRESETS["grok-build"], {
        version: { status: "untested", actual: "1.1.0" },
      }),
    ).toContainEqual(
      expect.objectContaining({
        code: "ACP_RUNTIME_VERSION_UNTESTED",
        level: "warning",
      }),
    );
  });

  it("validates protocol, required capabilities and Grok metadata", () => {
    const diagnostics = diagnosePreset(PRESETS["grok-build"], {
      initialise: {
        status: "ok",
        protocolVersion: 2,
        capabilityPaths: ["agentCapabilities.loadSession"],
        metadataPaths: ["modelState"],
      },
    });

    expect(diagnostics.map(({ code }) => code)).toEqual([
      "ACP_PROTOCOL_MISMATCH",
      "ACP_RUNTIME_FEATURE_MISSING",
      "ACP_INITIALISE_METADATA_MISSING",
    ]);
    expect(diagnostics[2]?.details).toEqual({
      missing: ["availableCommands", "defaultAuthMethodId"],
    });
  });

  it("reports capability-gated elicitation without claiming support", () => {
    const diagnostics = diagnosePreset(PRESETS.claude, {
      clientCapabilityPaths: ["terminal"],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "ACP_CLIENT_CAPABILITY_MISSING",
        level: "warning",
        details: { missing: ["elicitation.form"] },
      }),
    ]);
  });

  it("fails closed for auth/session failures and empty discovery", () => {
    const authDiagnostics = diagnosePreset(PRESETS.codex, {
      auth: {
        status: "required",
        methodIds: ["chat-gpt-device-code", "api-key", "api-key"],
      },
    });
    expect(authDiagnostics[0]).toMatchObject({
      code: "ACP_AUTH_REQUIRED",
      level: "action",
      details: { methodIds: ["api-key", "chat-gpt-device-code"] },
    });

    const sessionDiagnostics = diagnosePreset(PRESETS.cursor, {
      session: { status: "ok", modelCount: 0, modeCount: 0 },
    });
    expect(sessionDiagnostics.map(({ code }) => code)).toEqual([
      "ACP_MODEL_DISCOVERY_EMPTY",
      "ACP_MODE_DISCOVERY_EMPTY",
    ]);
  });

  it("deduplicates unhandled methods and flags Hermes' MCP mismatch", () => {
    const diagnostics = diagnosePreset(PRESETS.hermes, {
      requestedMcpServerCount: 2,
      unhandledReverseMethods: ["custom/b", "custom/a", "custom/b"],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "ACP_REVERSE_METHOD_UNHANDLED",
        details: { methods: ["custom/a", "custom/b"] },
      }),
      expect.objectContaining({
        code: "ACP_MCP_CAPABILITY_MISMATCH",
        details: { requested: 2 },
      }),
    ]);
  });
});

describe("summariseDiagnostics", () => {
  it("is healthy only when no fatal or action item remains", () => {
    const warningOnly = summariseDiagnostics([
      {
        code: "ACP_RUNTIME_VERSION_UNTESTED",
        level: "warning",
        message: "Untested",
      },
    ]);
    expect(warningOnly).toEqual({
      ok: true,
      highestLevel: "warning",
      counts: { fatal: 0, action: 0, warning: 1, info: 0 },
    });

    expect(
      summariseDiagnostics([
        { code: "ACP_AUTH_REQUIRED", level: "action", message: "Login" },
      ]),
    ).toMatchObject({ ok: false, highestLevel: "action" });
  });
});
