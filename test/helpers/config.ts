import { serverConfigSchema, type ServerConfig } from "../../src/config.js";

export function makeServerConfig(
  overrides: Record<string, unknown> = {},
): ServerConfig {
  return serverConfigSchema.parse({ preset: "cursor", ...overrides });
}
