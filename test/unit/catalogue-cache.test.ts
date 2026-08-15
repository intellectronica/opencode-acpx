import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CatalogueCache } from "../../src/catalogue-cache.js";
import { parsePluginOptions } from "../../src/config.js";
import type { CatalogueResult } from "../../src/worker/messages.js";

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), "opencode-acpx-catalogue-"));
  const options = parsePluginOptions({
    stateDir,
    servers: { cursor: { preset: "cursor" } },
  });
  const server = options.servers.cursor;
  if (server === undefined) throw new Error("Missing Cursor server fixture");
  const catalogue: CatalogueResult = {
    serverId: "cursor",
    cwd: "/workspace",
    currentModelId: "grok-4.6",
    models: [{ id: "grok-4.6", name: "Grok 4.6" }],
    configOptions: [],
    modelConfigOptions: {
      "grok-4.6": [
        {
          id: "effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    },
    availableCommands: [],
    runtimeCapabilities: { controls: [] },
    featureSupport: {
      permissions: { supported: true },
      extensions: { supported: true },
      elicitation: { supported: true },
      rawProtocolEvents: { supported: true },
      clientCapabilityControl: { supported: true },
    },
    statusDetails: { credential: "must-not-be-cached" },
  };
  return { stateDir, server, catalogue };
}

describe("catalogue cache", () => {
  it("round-trips model config options without persisting status details", async () => {
    const { stateDir, server, catalogue } = await fixture();
    const cache = new CatalogueCache(stateDir);

    await cache.put("cursor", server, "/workspace", catalogue);

    const restored = await cache.get("cursor", server, "/workspace");
    expect(restored).toMatchObject({
      serverId: "cursor",
      modelConfigOptions: catalogue.modelConfigOptions,
    });
    expect(restored?.statusDetails).toBeUndefined();
    const source = await readFile(
      join(stateDir, "catalogues", "cursor.json"),
      "utf8",
    );
    expect(source).not.toContain("must-not-be-cached");
  });

  it("reuses model metadata across cwd without leaking workspace commands", async () => {
    const { stateDir, server, catalogue } = await fixture();
    const cache = new CatalogueCache(stateDir);
    await cache.put("cursor", server, "/workspace", {
      ...catalogue,
      availableCommands: [{ name: "workspace-only" }],
    });

    await expect(cache.get("cursor", server, "/other")).resolves.toMatchObject({
      cwd: "/other",
      modelConfigOptions: catalogue.modelConfigOptions,
      availableCommands: [],
    });
    await expect(
      cache.get("cursor", { ...server, authProfile: "other" }, "/workspace"),
    ).resolves.toBeUndefined();
  });

  it("fails closed for malformed cache data", async () => {
    const { stateDir, server, catalogue } = await fixture();
    const cache = new CatalogueCache(stateDir);
    await cache.put("cursor", server, "/workspace", catalogue);
    await writeFile(
      join(stateDir, "catalogues", "cursor.json"),
      '{"schema":1,"fingerprint":"invalid","catalogue":{}}\n',
      "utf8",
    );

    await expect(
      cache.get("cursor", server, "/workspace"),
    ).resolves.toBeUndefined();
  });
});
