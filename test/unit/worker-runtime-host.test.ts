import { join } from "node:path";

import type { AcpRuntime, AcpRuntimeHandle } from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";

import { parsePluginOptions } from "../../src/config.js";
import type { RuntimeWorkerEvent } from "../../src/worker/messages.js";
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
  const operations: string[] = [];
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
  const setConfigOption = vi.fn(
    ({ key, value }: { key: string; value: string | boolean }) => {
      operations.push(`config:${key}:${String(value)}`);
      return Promise.resolve();
    },
  );
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
    setConfigOption,
  } as unknown as AcpRuntime;
  return { runtime, ensureSession, close, setConfigOption, operations };
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

  it("correlates Cursor task notifications that identify only a tool call", async () => {
    const fake = fakeRuntime();
    const events: Record<string, unknown>[] = [];
    let factoryInput: RuntimeFactoryInput | undefined;
    let finishTurn: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    fake.runtime.startTurn = vi.fn(() => ({
      requestId: "request-1",
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "tool_call" as const,
            text: "Explore",
            toolCallId: "cursor-task-1",
            kind: "other" as const,
            status: "in_progress",
          };
          await finished;
        },
      },
      result: finished.then(() => ({
        status: "completed" as const,
        stopReason: "end_turn",
      })),
      cancel: () => Promise.resolve(),
      closeStream: () => Promise.resolve(),
    }));
    const host = new RuntimeHost({
      emit: (event) => events.push(event as unknown as Record<string, unknown>),
      runtimeFactory: (input) => {
        factoryInput = input;
        return fake.runtime;
      },
    });
    await host.configure(configuration());
    await host.startTurn({
      turnId: "turn-1",
      serverId: "cursor",
      sessionKey: "session-1",
      cwd: process.cwd(),
      requestId: "request-1",
      text: "Explore",
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: "turn.event", turnId: "turn-1" }),
      ),
    );

    await factoryInput?.compatCallbacks.onExtensionNotification?.(
      "cursor/task",
      { toolCallId: "cursor-task-1", description: "Explore" },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "extension.notification",
        serverId: "cursor",
        sessionKey: "session-1",
        turnId: "turn-1",
        method: "cursor/task",
      }),
    );
    finishTurn?.();
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: "turn.result", turnId: "turn-1" }),
      ),
    );
    await host.dispose();
  });

  it("applies exact model and typed config selections before prompting", async () => {
    const fake = fakeRuntime();
    fake.runtime.startTurn = vi.fn(({ requestId }: { requestId: string }) => {
      fake.operations.push(`prompt:${requestId}`);
      return {
        requestId,
        events: {
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield* [];
          },
        },
        result: Promise.resolve({
          status: "completed" as const,
          stopReason: "end_turn",
        }),
        cancel: () => Promise.resolve(),
        closeStream: () => Promise.resolve(),
      };
    });
    const events: RuntimeWorkerEvent[] = [];
    const host = new RuntimeHost({
      emit: (event) => events.push(event),
      runtimeFactory: () => fake.runtime,
    });
    await host.configure(configuration());

    await host.startTurn({
      turnId: "variant-turn",
      serverId: "cursor",
      sessionKey: "variant-session",
      cwd: process.cwd(),
      requestId: "variant-request",
      text: "Think carefully",
      modelId: "smart",
      config: { effort: "high", fast: false },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.result",
          turnId: "variant-turn",
        }),
      ),
    );

    expect(fake.operations).toEqual([
      "config:model:smart",
      "config:effort:high",
      "config:fast:false",
      "prompt:variant-request",
    ]);
    expect(fake.setConfigOption.mock.calls[2]?.[0]).toMatchObject({
      key: "fast",
      value: false,
    });
    await host.dispose();
  });
});
