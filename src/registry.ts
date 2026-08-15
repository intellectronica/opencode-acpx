import type { AcpPermissionDecision } from "acpx/runtime";

import type { ServerConfig } from "./config.js";
import type { BindingLedger } from "./session/ledger.js";
import type { TurnStartParams } from "./worker/messages.js";
import type {
  ElicitationResponseParams,
  ExtensionResponseParams,
  RuntimeWorkerEvent,
} from "./worker/messages.js";
import type { TurnChannel } from "./worker/turn-channel.js";

export interface ProviderWorkerClient {
  startTurn(params: TurnStartParams): Promise<TurnChannel>;
  cancelTurn(turnId: string, reason?: string): Promise<unknown>;
  respondPermission(
    interactionId: string,
    decision: AcpPermissionDecision,
  ): Promise<unknown>;
  respondElicitation(
    interactionId: string,
    response: ElicitationResponseParams["response"],
  ): Promise<unknown>;
  respondExtension(params: ExtensionResponseParams): Promise<unknown>;
  closeSession(
    serverId: string,
    sessionKey: string,
    discardPersistentState?: boolean,
  ): Promise<unknown>;
  subscribe(listener: (event: RuntimeWorkerEvent) => void): () => void;
}

export interface ProviderRuntime {
  pluginInstanceId: string;
  providerId: string;
  client: ProviderWorkerClient;
  serverId: string;
  server: ServerConfig;
  directory: string;
  worktree: string;
  /** Optional durable binding ledger supplied by the plugin host. */
  ledger?: BindingLedger;
}

const REGISTRY_SYMBOL = Symbol.for(
  "opencode-acpx.provider-runtime-registry.v1",
);

interface RegistryGlobal {
  [REGISTRY_SYMBOL]?: Map<string, ProviderRuntime>;
}

function registry(): Map<string, ProviderRuntime> {
  const root = globalThis as typeof globalThis & RegistryGlobal;
  const existing = root[REGISTRY_SYMBOL];
  if (existing !== undefined) return existing;
  const value = new Map<string, ProviderRuntime>();
  root[REGISTRY_SYMBOL] = value;
  return value;
}

function runtimeKey(pluginInstanceId: string, providerId: string): string {
  if (pluginInstanceId.length === 0)
    throw new Error("pluginInstanceId must not be empty");
  if (providerId.length === 0) throw new Error("providerId must not be empty");
  return `${String(pluginInstanceId.length)}:${pluginInstanceId}${providerId}`;
}

export function registerProviderRuntime(runtime: ProviderRuntime): () => void {
  const key = runtimeKey(runtime.pluginInstanceId, runtime.providerId);
  const existing = registry().get(key);
  if (existing !== undefined && existing !== runtime) {
    throw new Error(
      `ACP provider runtime is already registered for ${runtime.pluginInstanceId}/${runtime.providerId}`,
    );
  }
  registry().set(key, runtime);
  return () => {
    if (registry().get(key) === runtime) registry().delete(key);
  };
}

export function getProviderRuntime(
  pluginInstanceId: string,
  providerId: string,
): ProviderRuntime | undefined {
  return registry().get(runtimeKey(pluginInstanceId, providerId));
}

export function unregisterProviderRuntime(
  pluginInstanceId: string,
  providerId: string,
): boolean {
  return registry().delete(runtimeKey(pluginInstanceId, providerId));
}
