import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  tool,
  type Config,
  type Hooks,
  type Plugin,
  type PluginInput,
  type PluginModule,
} from "@opencode-ai/plugin";

import {
  parsePluginOptions,
  type ConfiguredModel,
  type PluginOptions as AcpxPluginOptions,
  type ServerConfig,
} from "./config.js";
import {
  projectAcpModels,
  providerSelectionOptions,
  type AcpModelSelection,
} from "./model-variants.js";
import {
  INTERACTION_TOOL_NAME,
  PACKAGE_NAME,
  PERMISSION_TOOL_NAME,
} from "./constants.js";
import { PermissionInteractionBroker } from "./interactions/permission.js";
import { GenericInteractionBroker } from "./interactions/generic.js";
import {
  isSessionDeletedEvent,
  sessionDeletedId,
} from "./interactions/events.js";
import { providerId, resolvePreset } from "./presets.js";
import { registerProviderRuntime } from "./registry.js";
import { createSessionKey } from "./session/identity.js";
import { BindingLedger } from "./session/ledger.js";
import { WorkerClient, type WorkerClientOptions } from "./worker/client.js";
import type { CatalogueResult, RuntimeWorkerEvent } from "./worker/messages.js";

type ProviderModelConfig = NonNullable<
  NonNullable<NonNullable<Config["provider"]>[string]["models"]>[string]
>;

type ProviderModelConfigWithVariants = ProviderModelConfig & {
  variants?: Record<string, Record<string, unknown>>;
};

interface ProviderProjection {
  models: Record<string, ProviderModelConfigWithVariants>;
  routes: Map<string, AcpModelSelection>;
}

interface ConfigWithSkills extends Config {
  skills?: {
    paths?: string[];
    urls?: string[];
  };
}

interface ServerDependencies {
  createWorkerClient?: (options: WorkerClientOptions) => WorkerClient;
  pluginInstanceId?: () => string;
  providerUrl?: URL;
  workerPath?: string;
}

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROVIDER_URL = new URL("./provider.js", import.meta.url);
const DEFAULT_WORKER_PATH = join(SOURCE_DIRECTORY, "worker.js");

export function createServerPlugin(
  dependencies: ServerDependencies = {},
): Plugin {
  return async (input, rawOptions) => {
    const options = parsePluginOptions(rawOptions);
    const pluginInstanceId = dependencies.pluginInstanceId?.() ?? randomUUID();
    const createWorker =
      dependencies.createWorkerClient ??
      ((workerOptions) => new WorkerClient(workerOptions));
    const worker = createWorker({
      workerPath: dependencies.workerPath ?? DEFAULT_WORKER_PATH,
      pluginOptions: options,
      onDiagnostic: () => logDiagnostic(input, "warn", "ACP_WORKER_STDERR"),
    });
    const broker = new PermissionInteractionBroker({
      mode: options.permissions.default,
      fallback: options.permissions.fallback,
    });
    const genericBroker = new GenericInteractionBroker({
      respondElicitation: (interactionId, response) =>
        worker.respondElicitation(interactionId, response),
      respondExtension: (params) => worker.respondExtension(params),
    });
    const serverBySessionKey = new Map<string, string>();
    const variantsByMessage = new Map<string, string | undefined>();
    const unregisterRuntimes: (() => void)[] = [];
    const ledger = new BindingLedger({
      path: join(options.stateDir, "bindings.json"),
    });
    let disposed = false;

    const unsubscribe = worker.subscribe((event) => {
      observeWorkerEvent(event, broker);
      genericBroker.observeWorkerEvent(event);
      if (event.type === "diagnostic") {
        logDiagnostic(
          input,
          diagnosticLevel(event.level),
          event.code ?? "ACP_WORKER_DIAGNOSTIC",
          event.serverId,
        );
      }
    });

    try {
      await worker.configure({
        pluginInstanceId,
        directory: input.directory,
        options,
      });
    } catch {
      unsubscribe();
      await worker.dispose().catch(() => undefined);
      throw new Error("Unable to initialise the plugin-owned ACP worker");
    }

    const catalogues = await discoverCatalogues(
      worker,
      options,
      input.directory,
      (serverId) =>
        logDiagnostic(input, "warn", "ACP_CATALOGUE_UNAVAILABLE", serverId),
    );
    const providerProjections = new Map<string, ProviderProjection>();
    for (const [serverId, server] of Object.entries(options.servers)) {
      if (!server.enabled) continue;
      providerProjections.set(
        serverId,
        buildProviderProjection(serverId, server, catalogues.get(serverId)),
      );
    }

    for (const [serverId, server] of Object.entries(options.servers)) {
      if (!server.enabled) continue;
      const id = providerId(serverId);
      unregisterRuntimes.push(
        registerProviderRuntime({
          pluginInstanceId,
          providerId: id,
          client: worker,
          serverId,
          server,
          directory: serverWorkingDirectory(server, input.directory),
          worktree: serverWorkingDirectory(server, input.worktree),
          ledger,
        }),
      );
    }

    const hooks: Hooks = {
      config: async (config) => {
        await refreshTargetedCatalogues(
          worker,
          options,
          input.directory,
          config,
          catalogues,
          providerProjections,
        );
        injectConfiguration(
          config,
          options,
          pluginInstanceId,
          dependencies.providerUrl ?? DEFAULT_PROVIDER_URL,
          catalogues,
          providerProjections,
          input,
        );
        await Promise.resolve();
      },
      "chat.message": async (chat) => {
        if (chat.messageID === undefined) return;
        variantsByMessage.set(
          `${chat.sessionID}\u0000${chat.messageID}`,
          chat.variant,
        );
        await Promise.resolve();
      },
      "chat.params": async (chat, output) => {
        const serverId = serverIdForProvider(options, chat.model.providerID);
        if (serverId === undefined) return;
        const server = options.servers[serverId];
        if (server === undefined) return;
        const projection = providerProjections.get(serverId);
        const messageKey = `${chat.sessionID}\u0000${chat.message.id}`;
        const selectedVariant =
          runtimeMessageVariant(chat.message) ??
          variantsByMessage.get(messageKey);
        variantsByMessage.delete(messageKey);
        const route = projection?.routes.get(
          modelRouteKey(chat.model.id, selectedVariant),
        );
        if (route === undefined) {
          throw new Error(
            `Unknown or stale ACP model variant ${chat.model.id}/${selectedVariant ?? "default"}`,
          );
        }
        const generation = 0;
        const sessionKey = await createSessionKey({
          serverId,
          server,
          worktree: serverWorkingDirectory(server, input.worktree),
          openCodeSessionId: chat.sessionID,
          generation,
        });
        broker.bindSession(sessionKey, chat.sessionID);
        genericBroker.bindSession(sessionKey, chat.sessionID);
        serverBySessionKey.set(sessionKey, serverId);
        output.options.openCodeSessionId = chat.sessionID;
        output.options.requestId = chat.message.id;
        output.options.generation = generation;
        output.options.agent = chat.agent;
        output.options.opencodeAcpx = {
          schema: 1,
          ...(selectedVariant === undefined
            ? { variantId: null }
            : { variantId: selectedVariant }),
          ...structuredClone(route),
        };
        if (server.mode !== undefined && output.options.mode === undefined) {
          output.options.mode = server.mode;
        }
      },
      tool: {
        [PERMISSION_TOOL_NAME]: tool({
          description:
            "Completes a pending ACP agent permission request. This tool is reserved for opencode-acpx.",
          args: {
            interactionId: tool.schema.string().min(1),
            serverId: tool.schema.string().min(1),
            sessionKey: tool.schema.string().min(1),
            expiresAt: tool.schema.number().int().nonnegative(),
            request: tool.schema.unknown().optional(),
            inferredKind: tool.schema.string().optional(),
          },
          execute: async (args, context) =>
            broker.execute(
              {
                interactionId: args.interactionId,
                serverId: args.serverId,
                sessionKey: args.sessionKey,
                expiresAt: args.expiresAt,
                ...(args.request === undefined
                  ? {}
                  : { request: args.request }),
                ...(args.inferredKind === undefined
                  ? {}
                  : { inferredKind: args.inferredKind }),
              },
              context,
            ),
        }),
        [INTERACTION_TOOL_NAME]: tool({
          description:
            "Completes an ACP elicitation or vendor interaction. Until a compatible interaction transport is active, requests are cancelled safely.",
          args: {
            interactionId: tool.schema.string().min(1),
            serverId: tool.schema.string().min(1),
            sessionKey: tool.schema.string().min(1),
            expiresAt: tool.schema.number().int().nonnegative(),
            method: tool.schema.string().min(1),
            request: tool.schema.unknown().optional(),
          },
          execute: (args, context) => {
            return genericBroker.execute(
              {
                interactionId: args.interactionId,
                serverId: args.serverId,
                sessionKey: args.sessionKey,
                expiresAt: args.expiresAt,
                method: args.method,
                ...(args.request === undefined
                  ? {}
                  : { request: args.request }),
              },
              context,
            );
          },
        }),
      },
      "tool.execute.before": async (toolInput, output) => {
        broker.beforeToolExecute(PERMISSION_TOOL_NAME, toolInput, output.args);
        genericBroker.beforeToolExecute(
          INTERACTION_TOOL_NAME,
          toolInput,
          output.args,
        );
        genericBroker.beforeQuestionExecute(toolInput);
        await Promise.resolve();
      },
      "tool.execute.after": async (toolInput, output) => {
        await genericBroker.afterQuestionExecute(toolInput, output.metadata);
      },
      event: async ({ event }) => {
        const runtimeEvent = event as unknown;
        broker.ingestRuntimeEvent(runtimeEvent);
        await genericBroker.ingestOpenCodeEvent(runtimeEvent);
        if (isSessionDeletedEvent(runtimeEvent)) {
          genericBroker.deleteSession(sessionDeletedId(runtimeEvent));
        }
        const sessionKeys = broker.deletedSessionKeys(runtimeEvent);
        await Promise.all(
          sessionKeys.map(async (sessionKey) => {
            const serverId = serverBySessionKey.get(sessionKey);
            serverBySessionKey.delete(sessionKey);
            if (serverId === undefined) return;
            await worker
              .closeSession(serverId, sessionKey, false)
              .catch(() =>
                logDiagnostic(
                  input,
                  "warn",
                  "ACP_SESSION_CLOSE_FAILED",
                  serverId,
                ),
              );
          }),
        );
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        for (const unregister of unregisterRuntimes.splice(0)) unregister();
        await worker.dispose();
      },
    };
    return hooks;
  };
}

function runtimeMessageVariant(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return undefined;
  const model = (message as Record<string, unknown>).model;
  if (typeof model !== "object" || model === null || Array.isArray(model))
    return undefined;
  const variant = (model as Record<string, unknown>).variant;
  return typeof variant === "string" && variant.length > 0
    ? variant
    : undefined;
}

async function refreshTargetedCatalogues(
  worker: WorkerClient,
  options: AcpxPluginOptions,
  directory: string,
  config: Config,
  catalogues: Map<string, CatalogueResult>,
  projections: Map<string, ProviderProjection>,
): Promise<void> {
  await Promise.all(
    Object.entries(options.servers).map(async ([serverId, server]) => {
      if (!server.enabled) return;
      const existing = config.provider?.[providerId(serverId)];
      const modelIds = unique([
        ...(existing?.whitelist ?? []),
        ...Object.keys(server.models),
        ...(server.defaultModel === "default" ? [] : [server.defaultModel]),
      ]).filter((id) => id !== "default");
      if (modelIds.length === 0) return;
      try {
        const result = await withTimeout(
          worker.catalogue({
            serverId,
            cwd: serverWorkingDirectory(server, directory),
            modelIds,
          }),
          options.discoveryTimeoutMs,
        );
        if (!isCatalogueResult(result, serverId)) return;
        catalogues.set(serverId, result);
        projections.set(
          serverId,
          buildProviderProjection(serverId, server, result),
        );
      } catch {
        return;
      }
    }),
  );
}

export function buildProviderModels(
  serverId: string,
  server: ServerConfig,
  catalogue?: CatalogueResult,
): Record<string, ProviderModelConfig> {
  return buildProviderProjection(serverId, server, catalogue).models;
}

function buildProviderProjection(
  serverId: string,
  server: ServerConfig,
  catalogue?: CatalogueResult,
): ProviderProjection {
  const routes = new Map<string, AcpModelSelection>();
  const projected = projectAcpModels({
    preset: server.preset,
    models: catalogue?.models ?? [],
    ...(catalogue?.currentModelId === undefined
      ? {}
      : { currentModelId: catalogue.currentModelId }),
    configOptions: catalogue?.configOptions ?? [],
    modelConfigOptions: catalogue?.modelConfigOptions ?? {},
    configuredDefaults: server.config,
  });
  const baselineConfig =
    projected[0]?.selection.config ??
    Object.fromEntries(
      Object.entries(server.config).map(([key, value]) => [key, value]),
    );
  const defaultSelection: AcpModelSelection = {
    ...(catalogue?.currentModelId === undefined
      ? {}
      : { modelId: catalogue.currentModelId }),
    config: baselineConfig,
  };
  const models: Record<string, ProviderModelConfig> = {
    default: modelConfig(
      "Default",
      server.models.default,
      defaultSelection,
      {},
    ),
  };
  routes.set(modelRouteKey("default"), defaultSelection);
  for (const model of projected) {
    if (model.id.length === 0 || model.id === "default") continue;
    const configured = server.models[model.id];
    const variants = mergeConfiguredVariants(
      model.selection,
      model.variants,
      configured,
    );
    models[model.id] = modelConfig(
      model.name ?? model.id,
      configured,
      model.selection,
      variants,
    );
    routes.set(modelRouteKey(model.id), model.selection);
    for (const [variantId, variant] of Object.entries(variants)) {
      routes.set(modelRouteKey(model.id, variantId), variant.selection);
    }
  }
  for (const [modelId, configured] of Object.entries(server.models)) {
    const baseSelection = routes.get(modelRouteKey(modelId)) ?? {
      ...(modelId === "default" ? {} : { modelId }),
      config: { ...server.config },
    };
    const variants = mergeConfiguredVariants(baseSelection, {}, configured);
    models[modelId] = modelConfig(
      configured.name,
      configured,
      baseSelection,
      variants,
    );
    routes.set(modelRouteKey(modelId), baseSelection);
    for (const [variantId, variant] of Object.entries(variants)) {
      routes.set(modelRouteKey(modelId, variantId), variant.selection);
    }
  }
  if (
    server.defaultModel !== "default" &&
    models[server.defaultModel] === undefined
  ) {
    const selection: AcpModelSelection = {
      modelId: server.defaultModel,
      config: { ...server.config },
    };
    models[server.defaultModel] = modelConfig(
      server.defaultModel,
      server.models[server.defaultModel],
      selection,
      {},
    );
    routes.set(modelRouteKey(server.defaultModel), selection);
  }
  return { models, routes };
}

function injectConfiguration(
  config: Config,
  options: AcpxPluginOptions,
  pluginInstanceId: string,
  providerUrl: URL,
  catalogues: ReadonlyMap<string, CatalogueResult>,
  providerProjections: ReadonlyMap<string, ProviderProjection>,
  input: Pick<PluginInput, "directory" | "worktree">,
): void {
  config.provider ??= {};
  config.command ??= {};
  const addedProviderIds: string[] = [];
  for (const [serverId, server] of Object.entries(options.servers)) {
    if (!server.enabled) continue;
    const id = providerId(serverId);
    addedProviderIds.push(id);
    const existing = config.provider[id];
    const projection =
      providerProjections.get(serverId) ??
      buildProviderProjection(serverId, server, catalogues.get(serverId));
    ensureFilteredModelFallbacks(projection, server, existing?.whitelist);
    const models = projection.models;
    config.provider[id] = {
      ...existing,
      name: `${providerDisplayName(serverId, server)} (ACP)`,
      npm: providerUrl.href,
      options: { ...existing?.options, pluginInstanceId, serverId },
      models,
      ...(existing?.whitelist === undefined
        ? {}
        : { whitelist: expandModelFilter(existing.whitelist, models) }),
      ...(existing?.blacklist === undefined
        ? {}
        : { blacklist: expandModelFilter(existing.blacklist, models) }),
    };
    const commandName = `acp-${serverId}`;
    config.command[commandName] ??= {
      description: `Send a prompt to ${resolvePreset(server)?.title ?? serverId}`,
      model: `${id}/${server.defaultModel}`,
      template: "$ARGUMENTS",
    };
    for (const command of catalogues.get(serverId)?.availableCommands ?? []) {
      const suffix = commandNameSegment(command.name);
      if (suffix.length === 0) continue;
      const advertisedName = `${commandName}-${suffix}`;
      config.command[advertisedName] ??= {
        description:
          command.description ?? `Run /${command.name} in ${serverId}`,
        model: `${id}/${server.defaultModel}`,
        template: `/${command.name} $ARGUMENTS`,
      };
    }
  }
  if (config.enabled_providers !== undefined) {
    config.enabled_providers = unique([
      ...config.enabled_providers,
      ...addedProviderIds,
    ]);
  }
  injectSkillPaths(config as ConfigWithSkills, options, input);
}

function ensureFilteredModelFallbacks(
  projection: ProviderProjection,
  server: ServerConfig,
  whitelist: readonly string[] | undefined,
): void {
  for (const modelId of whitelist ?? []) {
    if (
      modelId.length === 0 ||
      modelId === "default" ||
      projection.models[modelId] !== undefined
    ) {
      continue;
    }
    const configured = server.models[modelId];
    const selection: AcpModelSelection = {
      modelId,
      config: { ...server.config },
    };
    const variants = mergeConfiguredVariants(selection, {}, configured);
    projection.models[modelId] = modelConfig(
      configured?.name ?? modelId,
      configured,
      selection,
      variants,
    );
    projection.routes.set(modelRouteKey(modelId), selection);
    for (const [variantId, variant] of Object.entries(variants)) {
      projection.routes.set(
        modelRouteKey(modelId, variantId),
        variant.selection,
      );
    }
  }
}

function injectSkillPaths(
  config: ConfigWithSkills,
  options: AcpxPluginOptions,
  input: Pick<PluginInput, "directory" | "worktree">,
): void {
  const paths: string[] = [];
  for (const server of Object.values(options.servers)) {
    if (!server.enabled || server.skills === "native") continue;
    const roots =
      server.skills === "shared-standard"
        ? [".agents/skills"]
        : (resolvePreset(server)?.nativeSkillRoots ?? [".agents/skills"]);
    for (const root of roots) {
      const relative = root.startsWith("./") ? root.slice(2) : root;
      paths.push(resolve(input.worktree || input.directory, relative));
      if (relative.startsWith(".")) paths.push(resolve(homedir(), relative));
    }
  }
  if (paths.length === 0) return;
  config.skills ??= {};
  config.skills.paths = unique([...(config.skills.paths ?? []), ...paths]);
}

async function discoverCatalogues(
  worker: WorkerClient,
  options: AcpxPluginOptions,
  directory: string,
  onFailure: (serverId: string) => void,
): Promise<Map<string, CatalogueResult>> {
  const catalogues = new Map<string, CatalogueResult>();
  await Promise.all(
    Object.entries(options.servers).map(async ([serverId, server]) => {
      if (!server.enabled) return;
      try {
        const result = await withTimeout(
          worker.catalogue({
            serverId,
            cwd: serverWorkingDirectory(server, directory),
          }),
          options.discoveryTimeoutMs,
        );
        if (isCatalogueResult(result, serverId))
          catalogues.set(serverId, result);
        else onFailure(serverId);
      } catch {
        onFailure(serverId);
      }
    }),
  );
  return catalogues;
}

function observeWorkerEvent(
  event: RuntimeWorkerEvent,
  broker: PermissionInteractionBroker,
): void {
  if (event.type !== "interaction.permission") return;
  broker.observeWorkerEvent(event, event.serverId);
}

function serverIdForProvider(
  options: AcpxPluginOptions,
  id: string,
): string | undefined {
  for (const [serverId, server] of Object.entries(options.servers)) {
    if (server.enabled && providerId(serverId) === id) return serverId;
  }
  return undefined;
}

function modelConfig(
  name: string,
  configured?: ConfiguredModel,
  selection?: AcpModelSelection,
  variants: Record<string, { selection: AcpModelSelection }> = {},
): ProviderModelConfigWithVariants {
  const configuredOptions = configured?.options ?? {};
  return {
    name,
    reasoning: configured?.reasoning ?? true,
    attachment: configured?.attachments ?? true,
    tool_call: true,
    limit: {
      context: configured?.context ?? 0,
      output: configured?.output ?? 0,
    },
    modalities: { input: ["text", "image", "audio"], output: ["text"] },
    options: {
      ...configuredOptions,
      ...(selection === undefined ? {} : providerSelectionOptions(selection)),
    },
    variants: Object.fromEntries(
      Object.entries(variants).map(([id, variant]) => [
        id,
        providerSelectionOptions(variant.selection),
      ]),
    ),
  };
}

function mergeConfiguredVariants(
  base: AcpModelSelection,
  discovered: Record<string, { selection: AcpModelSelection }>,
  configured?: ConfiguredModel,
): Record<string, { selection: AcpModelSelection }> {
  const result = structuredClone(discovered);
  for (const [id, variant] of Object.entries(configured?.variants ?? {})) {
    result[id] = {
      selection: {
        ...((variant.modelId ?? base.modelId) === undefined
          ? {}
          : { modelId: variant.modelId ?? base.modelId }),
        config: { ...base.config, ...variant.config },
      },
    };
  }
  return result;
}

function modelRouteKey(modelId: string, variantId?: string): string {
  return `${modelId}\u0000${variantId ?? ""}`;
}

function providerDisplayName(serverId: string, server: ServerConfig): string {
  switch (server.preset) {
    case "cursor":
      return "Cursor";
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "grok-build":
      return "Grok Build";
    case "hermes":
      return "Hermes";
    case "custom":
      return serverId;
  }
}

function isCatalogueResult(
  value: unknown,
  serverId: string,
): value is CatalogueResult {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (record.serverId !== serverId || !Array.isArray(record.models))
    return false;
  return record.models.every(
    (model) =>
      typeof model === "object" &&
      model !== null &&
      !Array.isArray(model) &&
      typeof (model as Record<string, unknown>).id === "string",
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function expandModelFilter(
  configured: string[],
  models: Record<string, ProviderModelConfig>,
): string[] {
  const modelIds = Object.keys(models);
  return unique(
    configured.flatMap((configuredId) => {
      if (models[configuredId] !== undefined) return [configuredId];
      const parameterised = modelIds.filter((modelId) =>
        modelId.startsWith(`${configuredId}[`),
      );
      return parameterised.length === 0 ? [configuredId] : parameterised;
    }),
  );
}

function serverWorkingDirectory(
  server: ServerConfig,
  fallback: string,
): string {
  return server.cwd === undefined ? fallback : resolve(fallback, server.cwd);
}

function commandNameSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function diagnosticLevel(
  level: "debug" | "info" | "warning" | "error",
): "debug" | "info" | "warn" | "error" {
  return level === "warning" ? "warn" : level;
}

function logDiagnostic(
  input: Pick<PluginInput, "client" | "directory">,
  level: "debug" | "info" | "warn" | "error",
  code: string,
  serverId?: string,
): void {
  void input.client.app
    .log({
      body: {
        service: PACKAGE_NAME,
        level,
        message: code,
        ...(serverId === undefined ? {} : { extra: { serverId } }),
      },
      query: { directory: input.directory },
    })
    .catch(() => undefined);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("ACP catalogue discovery timed out")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const serverModule = {
  id: PACKAGE_NAME,
  server: createServerPlugin(),
} satisfies PluginModule;

export default serverModule;
