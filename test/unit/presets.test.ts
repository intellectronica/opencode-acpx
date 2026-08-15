import { describe, expect, it } from "vitest";

import {
  PRESETS,
  providerId,
  resolveConfiguredCommand,
  resolvePreset,
} from "../../src/presets.js";
import { makeServerConfig } from "../helpers/config.js";

describe("PRESETS", () => {
  it.each([
    ["cursor", "cursor-agent", ["acp"], "session", true],
    [
      "claude",
      "npx",
      ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
      "profile",
      false,
    ],
    [
      "codex",
      "npx",
      ["-y", "@agentclientprotocol/codex-acp@1.3.0"],
      "profile",
      false,
    ],
    ["grok-build", "grok", ["agent", "--no-leader", "stdio"], "profile", true],
    ["hermes", "hermes", ["acp"], "profile", true],
  ] as const)(
    "defines the pinned %s adapter contract",
    (id, command, args, processIsolation, supportsLegacyModels) => {
      const preset = PRESETS[id];

      expect(preset.id).toBe(id);
      expect(preset.command).toEqual({ command, args: [...args] });
      expect(preset.processIsolation).toBe(processIsolation);
      expect(preset.supportsLegacyModels).toBe(supportsLegacyModels);
      expect(preset.nativeSkillRoots).toContain(".agents/skills");
      expect(preset.installHint.length).toBeGreaterThan(0);
    },
  );

  it("keeps the Cursor and Hermes executable fallbacks", () => {
    expect(PRESETS.cursor.fallbacks).toEqual([
      { command: "agent", args: ["acp"] },
    ]);
    expect(PRESETS.hermes.fallbacks).toEqual([
      { command: "hermes-acp", args: [] },
    ]);
  });

  it("pins adapter packages exactly and feature-probes system agents", () => {
    expect(PRESETS.claude.version).toMatchObject({
      kind: "npm-exact",
      package: "@agentclientprotocol/claude-agent-acp",
      version: "0.68.0",
    });
    expect(PRESETS.codex.version).toMatchObject({
      kind: "npm-exact",
      package: "@agentclientprotocol/codex-acp",
      version: "1.3.0",
    });
    expect(PRESETS.cursor.version.kind).toBe("system-feature-probe");
    expect(PRESETS["grok-build"].version).toMatchObject({
      kind: "system-feature-probe",
      minimumVersion: "1.0.4",
    });
    expect(PRESETS.hermes.version).toMatchObject({
      kind: "system-feature-probe",
      minimumVersion: "0.20.1",
    });
  });

  it("records runtime-specific discovery and control contracts", () => {
    expect(PRESETS.cursor.discovery.models).toContainEqual({
      kind: "config-option",
      id: "model",
    });
    expect(PRESETS.codex.controls.config).toContainEqual({
      kind: "config-option",
      id: "collaboration_mode",
    });
    expect(PRESETS["grok-build"].discovery.models).toContainEqual({
      kind: "initialise-meta",
      path: "modelState",
    });
    expect(PRESETS.hermes.controls.model).toContainEqual({
      kind: "session-method",
      method: "session/set_model",
    });
    expect(PRESETS.hermes.discovery.skills).toContainEqual(
      expect.objectContaining({ kind: "agent-native" }),
    );
  });

  it("records exact auth and reverse-interaction identifiers", () => {
    expect(PRESETS.cursor.auth.methodIds).toEqual(["cursor_login"]);
    expect(PRESETS.claude.auth.methodIds).toContain("gateway-bedrock");
    expect(PRESETS.codex.auth.methodIds).toContain("chat-gpt-device-code");
    expect(PRESETS["grok-build"].auth.methodIds).toEqual([
      "xai.api_key",
      "cached_token",
      "grok.com",
      "oidc",
    ]);
    expect(PRESETS.hermes.auth.methodIds).toEqual(["hermes-setup"]);
    expect(PRESETS["grok-build"].extensions.agentToClient).toEqual([
      "x.ai/ask_user_question",
      "x.ai/exit_plan_mode",
    ]);
  });

  it("keeps known capability advertisement mismatches explicit", () => {
    expect(PRESETS.hermes.mcp.knownAdvertisementMismatch).toBe(true);
    expect(PRESETS.hermes.capabilities.mcp).toEqual({
      stdio: "known-unadvertised",
      http: "known-unadvertised",
      sse: "known-unadvertised",
    });
    expect(
      PRESETS["grok-build"].diagnostics.requiredInitialiseMetadata,
    ).toEqual(["modelState", "availableCommands", "defaultAuthMethodId"]);
  });
});

describe("preset resolution", () => {
  it("resolves a named preset and leaves custom servers unbound", () => {
    expect(resolvePreset(makeServerConfig())).toBe(PRESETS.cursor);
    expect(
      resolvePreset(makeServerConfig({ preset: "custom", command: "agent" })),
    ).toBeUndefined();
  });

  it("uses the preset command by default", () => {
    expect(
      resolveConfiguredCommand(makeServerConfig({ preset: "codex" })),
    ).toEqual(PRESETS.codex.command);
  });

  it("allows command and argument overrides independently", () => {
    expect(
      resolveConfiguredCommand(makeServerConfig({ command: "custom-cursor" })),
    ).toEqual({
      command: "custom-cursor",
      args: ["acp"],
    });
    expect(
      resolveConfiguredCommand(
        makeServerConfig({ args: ["acp", "--verbose"] }),
      ),
    ).toEqual({
      command: "cursor-agent",
      args: ["acp", "--verbose"],
    });
  });

  it("uses an empty argument list for a custom command", () => {
    expect(
      resolveConfiguredCommand(
        makeServerConfig({ preset: "custom", command: "my-agent" }),
      ),
    ).toEqual({ command: "my-agent", args: [] });
  });

  it("rejects a custom server without a command", () => {
    expect(() =>
      resolveConfiguredCommand(makeServerConfig({ preset: "custom" })),
    ).toThrow("Custom ACP servers require a command");
  });

  it("namespaces provider identifiers", () => {
    expect(providerId("cursor.local")).toBe("acp.cursor.local");
  });
});
