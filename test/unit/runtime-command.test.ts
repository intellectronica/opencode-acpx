import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parsePluginOptions } from "../../src/config.js";
import { resolveRuntimeCommand } from "../../src/runtime-command.js";

function server(preset: "claude" | "codex" | "cursor") {
  const value = parsePluginOptions({ servers: { test: { preset } } }).servers
    .test;
  if (value === undefined) throw new Error("test server was not parsed");
  return value;
}

describe("resolveRuntimeCommand", () => {
  it.each([
    ["claude", "@agentclientprotocol+claude-agent-acp@0.68.0"],
    ["codex", "@agentclientprotocol+codex-acp@1.3.0"],
  ] as const)("uses the bundled exact %s adapter", async (preset, marker) => {
    const command = resolveRuntimeCommand(server(preset));

    expect(command.command).toBe(process.execPath);
    expect(command.args).toHaveLength(1);
    const adapterPath = command.args[0];
    if (adapterPath === undefined) throw new Error("adapter path is missing");
    expect(adapterPath).toContain(marker);
    await expect(access(adapterPath)).resolves.toBeUndefined();
  });

  it("keeps system-runtime presets unchanged", () => {
    expect(resolveRuntimeCommand(server("cursor"), () => true)).toEqual({
      command: "cursor-agent",
      args: ["acp"],
    });
  });

  it("uses a tested fallback when the primary executable is unavailable", () => {
    expect(
      resolveRuntimeCommand(server("cursor"), (command) => command === "agent"),
    ).toEqual({ command: "agent", args: ["acp"] });
  });

  it("honours an explicit command and argv override", () => {
    const configured = parsePluginOptions({
      servers: {
        test: {
          preset: "claude",
          command: "/opt/acp",
          args: ["--stdio"],
        },
      },
    }).servers.test;
    if (configured === undefined) throw new Error("test server was not parsed");

    expect(resolveRuntimeCommand(configured)).toEqual({
      command: "/opt/acp",
      args: ["--stdio"],
    });
  });
});
