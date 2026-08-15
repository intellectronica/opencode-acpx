import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_INTERACTION_TIMEOUT_MS,
} from "./constants.js";

export const presetIdSchema = z.enum([
  "cursor",
  "claude",
  "codex",
  "grok-build",
  "hermes",
  "custom",
]);
export type PresetId = z.infer<typeof presetIdSchema>;

const environmentSchema = z.record(z.string(), z.string());
const namedValueSchema = z
  .object({ name: z.string().min(1), value: z.string() })
  .strict();

const stdioMcpServerSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.array(namedValueSchema).default([]),
  })
  .strict();

const remoteMcpServerSchema = z
  .object({
    name: z.string().min(1),
    url: z.url(),
    type: z.enum(["http", "sse"]),
    headers: z.array(namedValueSchema).default([]),
  })
  .strict();

export const mcpServerSchema = z.union([
  stdioMcpServerSchema,
  remoteMcpServerSchema,
]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const configuredModelSchema = z
  .object({
    name: z.string().min(1),
    reasoning: z.boolean().default(true),
    attachments: z.boolean().default(true),
    context: z.number().int().nonnegative().default(0),
    output: z.number().int().nonnegative().default(0),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type ConfiguredModel = z.infer<typeof configuredModelSchema>;

const serverIdPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export const serverConfigSchema = z
  .object({
    preset: presetIdSchema,
    enabled: z.boolean().default(true),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    authProfile: z.string().min(1).default("default"),
    env: environmentSchema.default({}),
    forwardEnv: z.array(z.string().min(1)).default([]),
    models: z.record(z.string(), configuredModelSchema).default({}),
    defaultModel: z.string().min(1).default("default"),
    mode: z.string().min(1).optional(),
    config: z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .default({}),
    mcpServers: z.array(mcpServerSchema).default([]),
    nativeSystemPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    maxTurns: z.number().int().positive().optional(),
    processIsolation: z.enum(["session", "profile"]).optional(),
    skills: z
      .enum(["native", "shared-standard", "mirror-known-roots"])
      .default("native"),
  })
  .strict();
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const pluginOptionsSchema = z
  .object({
    stateDir: z.string().min(1).default("~/.local/share/opencode/acpx"),
    discoveryTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_DISCOVERY_TIMEOUT_MS),
    idleTimeoutMs: z.number().int().positive().default(DEFAULT_IDLE_TIMEOUT_MS),
    interactionTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_INTERACTION_TIMEOUT_MS),
    trace: z.boolean().default(false),
    permissions: z
      .object({
        default: z.enum(["ask", "allow", "deny"]).default("ask"),
        fallback: z.enum(["deny", "fail"]).default("deny"),
      })
      .strict()
      .default({ default: "ask", fallback: "deny" }),
    servers: z
      .record(
        z.string().regex(serverIdPattern, "Invalid ACP server identifier"),
        serverConfigSchema,
      )
      .refine(
        (servers) => Object.keys(servers).length > 0,
        "At least one ACP server is required",
      ),
  })
  .strict();
export type PluginOptions = z.infer<typeof pluginOptionsSchema>;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function parsePluginOptions(value: unknown): PluginOptions {
  const parsed = pluginOptionsSchema.parse(value);
  return { ...parsed, stateDir: expandHome(parsed.stateDir) };
}
