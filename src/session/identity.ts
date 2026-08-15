import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import type { ServerConfig } from "../config.js";
import { SESSION_SCHEMA_VERSION } from "../constants.js";
import { resolveConfiguredCommand } from "../presets.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function serverFingerprint(
  serverId: string,
  server: ServerConfig,
): string {
  const command = resolveConfiguredCommand(server);
  return digest({
    schema: SESSION_SCHEMA_VERSION,
    serverId,
    preset: server.preset,
    command,
    authProfile: server.authProfile,
    envKeys: Object.keys(server.env).sort(),
    forwardEnv: [...server.forwardEnv].sort(),
    mcpServers: server.mcpServers,
    nativeSystemPrompt: server.nativeSystemPrompt,
    appendSystemPrompt: server.appendSystemPrompt,
    allowedTools: server.allowedTools,
    maxTurns: server.maxTurns,
  });
}

export async function canonicalWorktree(path: string): Promise<string> {
  return realpath(path);
}

export interface SessionIdentityInput {
  serverId: string;
  server: ServerConfig;
  worktree: string;
  openCodeSessionId: string;
  generation?: number;
}

export async function createSessionKey(
  input: SessionIdentityInput,
): Promise<string> {
  const worktree = await canonicalWorktree(input.worktree);
  const fingerprint = serverFingerprint(input.serverId, input.server);
  const value = digest({
    schema: SESSION_SCHEMA_VERSION,
    fingerprint,
    worktree,
    openCodeSessionId: input.openCodeSessionId,
    generation: input.generation ?? 0,
  });
  return `opencode-acpx-v${String(SESSION_SCHEMA_VERSION)}-${value}`;
}
