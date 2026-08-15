import { join } from "node:path";

import type { AcpRuntime, AcpRuntimeHandle } from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";

import { parsePluginOptions } from "../../src/config.js";
import {
  RuntimeHost,
  STOCK_ACPX_FEATURE_SUPPORT,
  type RuntimeFactoryInput,
} from "../../src/worker/runtime-host.js";

function configuration() {
  return {
    pluginInstanceId: "plugin-1",
    directory: process.cwd(),
    options: parsePluginOptions({
      stateDir: join(process.cwd(), ".artifacts", "worker-runtime-host-test"),
      idleTimeoutMs: 60_000,
      servers: {
        cursor: {
          preset: "custom",
          command: "cursor-agent",
        },
      },
    }),
  };
}

function fakeRuntime() {
  const handles = new Map<string, AcpRuntimeHandle>();
  const ensureSession = vi.fn(
    ({ sessionKey, cwd }: { sessionKey: string; cwd?: string }) => {
      const handle: AcpRuntimeHandle = {
        sessionKey,
        backend: "cursor",
        runtimeSessionName: sessionKey,
        backendSessionId: `backend:${sessionKey}`,
        ...(cwd === undefined ? {} : { cwd }),
      };
      handles.set(sessionKey, handle);
      return Promise.resolve(handle);
    },
  );
  const close = vi.fn(({ handle }: { handle: AcpRuntimeHandle }) => {
    handles.delete(handle.sessionKey);
    return Promise.resolve();
  });
  const runtime = {
    ensureSession,
    close,
    getCapabilities: vi.fn(() => ({ controls: ["session/status"] })),
    getStatus: vi.fn(() =>
      Promise.resolve({
        models: {
          currentModelId: "fast",
          availableModelIds: ["fast", "smart"],
        },
        availableCommands: [
          { name: "compact", description: "Compact context" },
        ],
        details: {
          configOptions: [
            {
              id: "model",
              category: "model",
              options: [{ value: "fast", label: "Fast model" }],
            },
          ],
        },
      }),
    ),
  } as unknown as AcpRuntime;
  return { runtime, ensureSession, close };
}

describe("RuntimeHost", () => {
  it("configures idempotently and reports Acpx compatibility support", async () => {
    const fake = fakeRuntime();
    const events: unknown[] = [];
    const host = new RuntimeHost({
      emit: (event) => events.push(event),
      runtimeFactory: () => fake.runtime,
    });
    const config = configuration();
    await host.configure(config);
    await host.configure(structuredClone(config));

    expect(host.capabilities).not.toEqual(STOCK_ACPX_FEATURE_SUPPORT);
    expect(host.capabilities.elicitation.supported).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "diagnostic",
          code: "ACPX_RUNTIME_CLIENT_CAPABILITIES_PARTIAL",
          serverId: "cursor",
        }),
      ]),
    );
    await expect(
      host.configure({
        ...config,
        directory: join(config.directory, "different"),
      }),
    ).rejects.toMatchObject({
      code: "CONFIGURATION_CONFLICT",
    });
    await host.dispose();
    await host.dispose();
  });

  it("extracts a catalogue and explicitly closes its session", async () => {
    const fake = fakeRuntime();
    const host = new RuntimeHost({
      emit: () => undefined,
      runtimeFactory: () => fake.runtime,
    });
    await host.configure(configuration());

    const catalogue = await host.catalogue({
      serverId: "cursor",
      cwd: process.cwd(),
    });
    expect(catalogue.currentModelId).toBe("fast");
    expect(catalogue.models).toEqual([
      { id: "fast", name: "Fast model" },
      { id: "smart" },
    ]);
    expect(catalogue.availableCommands).toEqual([
      { name: "compact", description: "Compact context" },
    ]);
    expect(fake.ensureSession).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "OpenCode catalogue probe completed",
        discardPersistentState: true,
      }),
    );
    await host.dispose();
  });

  it("keeps a discovered catalogue when the agent lacks session/close", async () => {
    const fake = fakeRuntime();
    fake.close.mockRejectedValueOnce(
      Object.assign(new Error("session/close is unsupported"), {
        code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      }),
    );
    const events: Record<string, unknown>[] = [];
    const host = new RuntimeHost({
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      runtimeFactory: () => fake.runtime,
    });
    await host.configure(configuration());

    await expect(
      host.catalogue({ serverId: "cursor", cwd: process.cwd() }),
    ).resolves.toMatchObject({ currentModelId: "fast" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic",
        level: "info",
        code: "CATALOGUE_SESSION_CLOSE_UNSUPPORTED",
        serverId: "cursor",
      }),
    );
    await host.dispose();
  });

  it("correlates elicitation and extension requests with typed responses", async () => {
    const fake = fakeRuntime();
    const events: Record<string, unknown>[] = [];
    let factoryInput: RuntimeFactoryInput | undefined;
    const host = new RuntimeHost({
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      runtimeFactory: (input) => {
        factoryInput = input;
        return fake.runtime;
      },
    });
    await host.configure(configuration());
    const callbacks = factoryInput?.compatCallbacks;
    expect(callbacks).toBeDefined();

    const elicitation = callbacks?.onElicitationRequest?.(
      { sessionId: "backend:session", message: "Choose" } as never,
      { signal: new AbortController().signal },
    );
    const elicitationEvent = events.find(
      (event) => event.type === "interaction.elicitation",
    );
    expect(elicitationEvent).toMatchObject({ serverId: "cursor" });
    host.respondElicitation({
      interactionId: String(elicitationEvent?.interactionId),
      response: { action: "cancel" },
    });
    await expect(elicitation).resolves.toEqual({ action: "cancel" });

    const extension = callbacks?.onExtensionRequest?.(
      "vendor/example",
      { sessionId: "backend:session", value: 1 },
      { signal: new AbortController().signal },
    );
    const extensionEvent = events.find(
      (event) => event.type === "interaction.extension",
    );
    expect(extensionEvent).toMatchObject({
      serverId: "cursor",
      method: "vendor/example",
    });
    host.respondExtension({
      interactionId: String(extensionEvent?.interactionId),
      result: { accepted: true },
    });
    await expect(extension).resolves.toEqual({ accepted: true });
    await host.dispose();
  });
});
