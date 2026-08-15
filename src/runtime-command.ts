import { constants } from "node:fs";
import { accessSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, extname, isAbsolute, join } from "node:path";

import type { ServerConfig } from "./config.js";
import {
  resolveConfiguredCommand,
  resolvePreset,
  type AgentCommand,
} from "./presets.js";

const require = createRequire(import.meta.url);

const BUNDLED_ADAPTERS = {
  claude: "@agentclientprotocol/claude-agent-acp/dist/index.js",
  codex: "@agentclientprotocol/codex-acp/dist/index.js",
} as const;

/**
 * Resolve the executable used by the worker. The two JavaScript adapters are
 * shipped as exact dependencies, so normal launches never depend on the
 * network or on an unrelated global package version.
 */
export function resolveRuntimeCommand(
  server: ServerConfig,
  executableAvailable: (command: string) => boolean = isExecutableAvailable,
): AgentCommand {
  if (server.command !== undefined || server.args !== undefined) {
    return resolveConfiguredCommand(server);
  }
  if (server.preset === "claude" || server.preset === "codex") {
    return {
      command: process.execPath,
      args: [require.resolve(BUNDLED_ADAPTERS[server.preset])],
    };
  }
  const configured = resolveConfiguredCommand(server);
  const preset = resolvePreset(server);
  return (
    [configured, ...(preset?.fallbacks ?? [])].find((candidate) =>
      executableAvailable(candidate.command),
    ) ?? configured
  );
}

function isExecutableAvailable(command: string): boolean {
  const candidates =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [command]
      : executableCandidates(command);
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function executableCandidates(command: string): string[] {
  const pathDirectories = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const extensions =
    process.platform === "win32" && extname(command) === ""
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  return pathDirectories.flatMap((directory) =>
    extensions.map((extension) => join(directory, `${command}${extension}`)),
  );
}
