import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ServerConfig } from "./config.js";
import type { CatalogueResult } from "./worker/messages.js";

interface CatalogueCacheDocument {
  schema: 1;
  fingerprint: string;
  cachedAt: string;
  catalogue: CatalogueResult;
}

export class CatalogueCache {
  readonly #directory: string;

  constructor(stateDir: string) {
    this.#directory = join(stateDir, "catalogues");
  }

  async get(
    serverId: string,
    server: ServerConfig,
    cwd: string,
  ): Promise<CatalogueResult | undefined> {
    try {
      const source = await readFile(this.#path(serverId), "utf8");
      const parsed: unknown = JSON.parse(source);
      if (!isCacheDocument(parsed)) return undefined;
      if (parsed.fingerprint !== catalogueFingerprint(server)) return undefined;
      if (!isCachedCatalogue(parsed.catalogue, serverId)) return undefined;
      if (parsed.catalogue.cwd === cwd) return parsed.catalogue;
      return {
        ...parsed.catalogue,
        cwd,
        // Commands are workspace-scoped even though model/config discovery is
        // agent-profile scoped. Never leak them into another project.
        availableCommands: [],
      };
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined;
      return undefined;
    }
  }

  async put(
    serverId: string,
    server: ServerConfig,
    cwd: string,
    catalogue: CatalogueResult,
  ): Promise<void> {
    if (!isCachedCatalogue(catalogue, serverId) || catalogue.cwd !== cwd)
      return;
    const path = this.#path(serverId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const document: CatalogueCacheDocument = {
      schema: 1,
      fingerprint: catalogueFingerprint(server),
      cachedAt: new Date().toISOString(),
      catalogue: sanitiseCatalogue(catalogue),
    };
    const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  }

  #path(serverId: string): string {
    return join(this.#directory, `${encodeURIComponent(serverId)}.json`);
  }
}

function catalogueFingerprint(server: ServerConfig): string {
  return createHash("sha256").update(JSON.stringify(server)).digest("hex");
}

function sanitiseCatalogue(catalogue: CatalogueResult): CatalogueResult {
  return {
    serverId: catalogue.serverId,
    cwd: catalogue.cwd,
    ...(catalogue.currentModelId === undefined
      ? {}
      : { currentModelId: catalogue.currentModelId }),
    models: catalogue.models,
    configOptions: catalogue.configOptions,
    modelConfigOptions: catalogue.modelConfigOptions,
    availableCommands: catalogue.availableCommands,
    runtimeCapabilities: catalogue.runtimeCapabilities,
    featureSupport: catalogue.featureSupport,
  };
}

function isCacheDocument(value: unknown): value is CatalogueCacheDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === 1 &&
    typeof record.fingerprint === "string" &&
    typeof record.cachedAt === "string" &&
    typeof record.catalogue === "object" &&
    record.catalogue !== null
  );
}

function isCachedCatalogue(
  value: unknown,
  serverId: string,
): value is CatalogueResult {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.serverId === serverId &&
    typeof record.cwd === "string" &&
    Array.isArray(record.models) &&
    record.models.every(
      (model) =>
        typeof model === "object" &&
        model !== null &&
        !Array.isArray(model) &&
        typeof (model as Record<string, unknown>).id === "string",
    ) &&
    Array.isArray(record.configOptions) &&
    isRecordOfArrays(record.modelConfigOptions) &&
    Array.isArray(record.availableCommands) &&
    typeof record.runtimeCapabilities === "object" &&
    record.runtimeCapabilities !== null &&
    typeof record.featureSupport === "object" &&
    record.featureSupport !== null
  );
}

function isRecordOfArrays(value: unknown): value is Record<string, unknown[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(Array.isArray)
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
