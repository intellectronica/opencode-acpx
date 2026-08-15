import { describe, expect, it } from "vitest";

import { makeServerConfig } from "../helpers/config.js";
import {
  getProviderRuntime,
  registerProviderRuntime,
  unregisterProviderRuntime,
  type ProviderRuntime,
} from "../../src/registry.js";

function runtime(
  pluginInstanceId: string,
  providerId: string,
): ProviderRuntime {
  return {
    pluginInstanceId,
    providerId,
    client: {
      startTurn: () => Promise.reject(new Error("unused in registry test")),
      cancelTurn: () => Promise.resolve(undefined),
      respondPermission: () => Promise.resolve(undefined),
      respondElicitation: () => Promise.resolve(undefined),
      respondExtension: () => Promise.resolve(undefined),
      closeSession: () => Promise.resolve(undefined),
      subscribe: () => () => undefined,
    },
    serverId: "cursor",
    server: makeServerConfig(),
    directory: process.cwd(),
    worktree: process.cwd(),
  };
}

describe("provider runtime registry", () => {
  it("isolates identical dotted provider IDs by plugin instance", () => {
    const first = runtime("plugin-one", "acp.cursor.work");
    const second = runtime("plugin-two", "acp.cursor.work");
    const releaseFirst = registerProviderRuntime(first);
    const releaseSecond = registerProviderRuntime(second);

    expect(getProviderRuntime("plugin-one", "acp.cursor.work")).toBe(first);
    expect(getProviderRuntime("plugin-two", "acp.cursor.work")).toBe(second);

    releaseFirst();
    releaseSecond();
  });

  it("rejects a conflicting registration without deleting the original", () => {
    const first = runtime("plugin", "acp.cursor");
    const second = runtime("plugin", "acp.cursor");
    const release = registerProviderRuntime(first);

    expect(() => registerProviderRuntime(second)).toThrow(/already registered/);
    expect(getProviderRuntime("plugin", "acp.cursor")).toBe(first);

    release();
  });

  it("does not let a stale release remove a replacement", () => {
    const first = runtime("plugin", "acp.cursor");
    const releaseFirst = registerProviderRuntime(first);
    expect(unregisterProviderRuntime("plugin", "acp.cursor")).toBe(true);
    const second = runtime("plugin", "acp.cursor");
    const releaseSecond = registerProviderRuntime(second);

    releaseFirst();
    expect(getProviderRuntime("plugin", "acp.cursor")).toBe(second);

    releaseSecond();
  });
});
