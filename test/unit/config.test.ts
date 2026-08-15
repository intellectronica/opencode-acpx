import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  configuredModelSchema,
  expandHome,
  mcpServerSchema,
  parsePluginOptions,
  pluginOptionsSchema,
  serverConfigSchema,
} from "../../src/config.js";
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_INTERACTION_TIMEOUT_MS,
} from "../../src/constants.js";

describe("pluginOptionsSchema", () => {
  it("fills every documented default for a minimal server", () => {
    const options = pluginOptionsSchema.parse({
      servers: { cursor: { preset: "cursor" } },
    });

    expect(options).toEqual({
      stateDir: "~/.local/share/opencode/acpx",
      discoveryTimeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      interactionTimeoutMs: DEFAULT_INTERACTION_TIMEOUT_MS,
      trace: false,
      permissions: { default: "ask", fallback: "deny" },
      servers: {
        cursor: {
          preset: "cursor",
          enabled: true,
          authProfile: "default",
          env: {},
          forwardEnv: [],
          models: {},
          defaultModel: "default",
          config: {},
          mcpServers: [],
          skills: "native",
        },
      },
    });
  });

  it.each([
    "",
    "UPPER",
    ".leading",
    "trailing-",
    "contains space",
    "slash/name",
  ])("rejects the invalid server identifier %j", (serverId) => {
    const parsed = pluginOptionsSchema.safeParse({
      servers: { [serverId]: { preset: "cursor" } },
    });

    expect(parsed.success).toBe(false);
  });

  it.each(["a", "cursor.local", "grok_build", "agent-2"])(
    "accepts the valid server identifier %j",
    (serverId) => {
      const parsed = pluginOptionsSchema.safeParse({
        servers: { [serverId]: { preset: "cursor" } },
      });

      expect(parsed.success).toBe(true);
    },
  );

  it("requires at least one server", () => {
    expect(pluginOptionsSchema.safeParse({ servers: {} }).success).toBe(false);
  });

  it("rejects unknown top-level and nested fields", () => {
    expect(
      pluginOptionsSchema.safeParse({
        servers: { cursor: { preset: "cursor" } },
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      pluginOptionsSchema.safeParse({
        servers: { cursor: { preset: "cursor", extra: true } },
      }).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5])("rejects the invalid timeout %j", (timeout) => {
    expect(
      pluginOptionsSchema.safeParse({
        discoveryTimeoutMs: timeout,
        servers: { cursor: { preset: "cursor" } },
      }).success,
    ).toBe(false);
  });
});

describe("serverConfigSchema", () => {
  it("preserves explicit process, model, tool and prompt settings", () => {
    const server = serverConfigSchema.parse({
      preset: "custom",
      command: "custom-agent",
      args: ["acp", "--stdio"],
      cwd: "/workspace",
      authProfile: "work",
      env: { PROFILE: "test" },
      forwardEnv: ["API_TOKEN"],
      defaultModel: "fast",
      models: { fast: { name: "Fast", reasoning: false } },
      mode: "agent",
      config: { model: "fast", thinking: false },
      nativeSystemPrompt: "System",
      appendSystemPrompt: "Append",
      allowedTools: [],
      maxTurns: 4,
      processIsolation: "session",
      skills: "shared-standard",
    });

    expect(server.models.fast).toEqual({
      name: "Fast",
      reasoning: false,
      attachments: true,
      context: 0,
      output: 0,
      options: {},
    });
    expect(server.allowedTools).toEqual([]);
    expect(server.maxTurns).toBe(4);
    expect(server.processIsolation).toBe("session");
  });

  it.each([0, -2, 1.5])("rejects maxTurns=%j", (maxTurns) => {
    expect(
      serverConfigSchema.safeParse({ preset: "cursor", maxTurns }).success,
    ).toBe(false);
  });
});

describe("model and MCP schemas", () => {
  it("applies model capability defaults", () => {
    expect(configuredModelSchema.parse({ name: "Default" })).toEqual({
      name: "Default",
      reasoning: true,
      attachments: true,
      context: 0,
      output: 0,
      options: {},
    });
  });

  it.each([{ context: -1 }, { output: 1.5 }, { name: "" }])(
    "rejects the invalid model fragment %j",
    (fragment) => {
      expect(
        configuredModelSchema.safeParse({ name: "Model", ...fragment }).success,
      ).toBe(false);
    },
  );

  it("accepts strict stdio and remote MCP server definitions", () => {
    expect(mcpServerSchema.parse({ name: "local", command: "mcp" })).toEqual({
      name: "local",
      command: "mcp",
      args: [],
      env: [],
    });
    expect(
      mcpServerSchema.parse({
        name: "remote",
        type: "http",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer token" }],
      }),
    ).toEqual({
      name: "remote",
      type: "http",
      url: "https://example.test/mcp",
      headers: [{ name: "Authorization", value: "Bearer token" }],
    });
  });

  it("rejects malformed, ambiguous and extended MCP definitions", () => {
    expect(
      mcpServerSchema.safeParse({ name: "local", command: "" }).success,
    ).toBe(false);
    expect(
      mcpServerSchema.safeParse({
        name: "remote",
        type: "http",
        url: "not a URL",
      }).success,
    ).toBe(false);
    expect(
      mcpServerSchema.safeParse({
        name: "remote",
        type: "websocket",
        url: "https://example.test",
      }).success,
    ).toBe(false);
    expect(
      mcpServerSchema.safeParse({ name: "local", command: "mcp", extra: true })
        .success,
    ).toBe(false);
  });
});

describe("path expansion", () => {
  it("expands the home directory forms only at the start of the path", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/state/sessions")).toBe(
      join(homedir(), "state/sessions"),
    );
    expect(expandHome("directory/~/state")).toBe(resolve("directory/~/state"));
  });

  it("resolves stateDir after validation", () => {
    const options = parsePluginOptions({
      stateDir: "./relative-state",
      servers: { cursor: { preset: "cursor" } },
    });

    expect(options.stateDir).toBe(resolve("./relative-state"));
  });
});
