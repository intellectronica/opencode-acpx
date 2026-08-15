/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/require-await */
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Config, PluginInput } from "@opencode-ai/plugin";
import { describe, expect, it, vi } from "vitest";

import { createServerPlugin } from "../../src/server.js";
import { parsePluginOptions } from "../../src/config.js";
import { createSessionKey } from "../../src/session/identity.js";
import type { WorkerClient } from "../../src/worker/client.js";
import type { RuntimeWorkerEvent } from "../../src/worker/messages.js";

const TEST_DIRECTORY = process.cwd();

function fakeWorker() {
  let listener: ((event: RuntimeWorkerEvent) => void) | undefined;
  return {
    configure: vi.fn(async () => {}),
    catalogue: vi.fn(async ({ serverId }: { serverId: string }) => ({
      serverId,
      cwd: TEST_DIRECTORY,
      models: [
        { id: "composer", name: "Composer" },
        {
          id: "grok-4.6[effort=high,fast=true]",
          name: "Grok 4.6",
        },
      ],
      configOptions: [],
      availableCommands: [{ name: "review", description: "Review the change" }],
      runtimeCapabilities: { controls: [] },
      featureSupport: {},
    })),
    request: vi.fn(async () => ({ ok: true })),
    respondElicitation: vi.fn(async () => ({ ok: true })),
    respondExtension: vi.fn(async () => ({ ok: true })),
    closeSession: vi.fn(async () => ({ ok: true, state: "closed" as const })),
    dispose: vi.fn(async () => {}),
    subscribe: vi.fn((next: (event: RuntimeWorkerEvent) => void) => {
      listener = next;
      return vi.fn(() => {
        listener = undefined;
      });
    }),
    emit(event: RuntimeWorkerEvent) {
      listener?.(event);
    },
  };
}

function pluginInput(log = vi.fn(async () => ({}))): PluginInput {
  return {
    client: { app: { log } } as unknown as PluginInput["client"],
    project: {
      id: "project",
      worktree: TEST_DIRECTORY,
      time: { created: 0 },
    },
    directory: TEST_DIRECTORY,
    worktree: TEST_DIRECTORY,
    serverUrl: new URL("http://localhost:4096"),
    experimental_workspace: { register: vi.fn() },
    $: undefined as unknown as PluginInput["$"],
  };
}

function options() {
  return {
    discoveryTimeoutMs: 100,
    servers: {
      cursor: {
        preset: "cursor",
        defaultModel: "default",
        skills: "shared-standard",
        models: {
          configured: {
            name: "Configured",
            reasoning: false,
            attachments: false,
            context: 10,
            output: 5,
            options: { effort: "low" },
          },
        },
      },
    },
  };
}

describe("server plugin", () => {
  it("configures its worker and injects a file provider, models, command, and shared skills", async () => {
    const worker = fakeWorker();
    const plugin = createServerPlugin({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "instance-1",
      providerUrl: new URL("file:///plugin/provider.js"),
      workerPath: "/plugin/worker.js",
    });
    const hooks = await plugin(pluginInput(), options());
    const config: Config & { skills?: { paths?: string[] } } = {
      enabled_providers: ["anthropic"],
      provider: {
        "acp.cursor": {
          whitelist: ["composer", "grok-4.6"],
          blacklist: ["default"],
          options: { configuredByUser: true },
        },
      },
      command: {
        "acp-cursor": { template: "preserve me" },
      },
    };

    await hooks.config?.(config);

    expect(worker.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginInstanceId: "instance-1",
        directory: TEST_DIRECTORY,
      }),
    );
    expect(config.provider?.["acp.cursor"]).toMatchObject({
      name: "Cursor (ACP)",
      npm: "file:///plugin/provider.js",
      whitelist: ["composer", "grok-4.6"],
      blacklist: ["default"],
      options: {
        configuredByUser: true,
        pluginInstanceId: "instance-1",
        serverId: "cursor",
      },
      models: {
        default: { name: "Default", tool_call: true },
        composer: { name: "Composer" },
        configured: {
          name: "Configured",
          reasoning: false,
          attachment: false,
          limit: { context: 10, output: 5 },
          options: { effort: "low" },
        },
      },
    });
    const grokModel = config.provider?.["acp.cursor"]?.models?.["grok-4.6"] as
      | {
          variants?: Record<string, { opencodeAcpx?: { modelId?: string } }>;
        }
      | undefined;
    expect(grokModel?.variants?.["high-fast"]?.opencodeAcpx?.modelId).toBe(
      "grok-4.6[effort=high,fast=true]",
    );
    expect(config.enabled_providers).toEqual(["anthropic", "acp.cursor"]);
    expect(config.command?.["acp-cursor"]).toEqual({ template: "preserve me" });
    expect(config.command?.["acp-cursor-review"]).toEqual({
      description: "Review the change",
      model: "acp.cursor/default",
      template: "/review $ARGUMENTS",
    });
    expect(config.skills?.paths).toEqual([
      resolve(TEST_DIRECTORY, ".agents/skills"),
      resolve(homedir(), ".agents/skills"),
    ]);
    await hooks.dispose?.();
  });

  it("routes only the matching provider and closes its session on deletion", async () => {
    const worker = fakeWorker();
    const plugin = createServerPlugin({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "instance-2",
    });
    const hooks = await plugin(pluginInput(), options());
    const routed = {
      temperature: 0,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: {},
    };
    const ignored = {
      temperature: 0,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: {},
    };
    const chat = {
      sessionID: "oc-session",
      agent: "build",
      model: { providerID: "acp.cursor", id: "default" },
      provider: {},
      message: { id: "message-1" },
    };

    await hooks["chat.message"]?.(
      {
        sessionID: "oc-session",
        agent: "build",
        model: { providerID: "acp.cursor", modelID: "default" },
        messageID: "message-1",
      },
      { message: chat.message as never, parts: [] },
    );
    await hooks["chat.params"]?.(chat as never, routed);
    await hooks["chat.params"]?.(
      { ...chat, model: { providerID: "anthropic" } } as never,
      ignored,
    );

    expect(routed.options).toMatchObject({
      openCodeSessionId: "oc-session",
      requestId: "message-1",
      generation: 0,
      agent: "build",
    });
    expect(ignored.options).toEqual({});

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "oc-session" } },
      } as never,
    });
    expect(worker.closeSession).toHaveBeenCalledWith(
      "cursor",
      expect.stringMatching(/^opencode-acpx-v1-/),
      false,
    );
    await hooks.dispose?.();
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  it("routes the selected OpenCode variant to its exact opaque ACP model ID", async () => {
    const worker = fakeWorker();
    const hooks = await createServerPlugin({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "instance-variant",
    })(pluginInput(), options());
    const output = {
      temperature: 0,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: {},
    };
    await hooks["chat.params"]?.(
      {
        sessionID: "variant-session",
        agent: "build",
        model: { providerID: "acp.cursor", id: "grok-4.6" },
        provider: {},
        message: {
          id: "variant-message",
          model: {
            providerID: "acp.cursor",
            modelID: "grok-4.6",
            variant: "high-fast",
          },
        },
      } as never,
      output,
    );

    expect(output.options).toMatchObject({
      opencodeAcpx: {
        schema: 1,
        variantId: "high-fast",
        modelId: "grok-4.6[effort=high,fast=true]",
        config: {},
      },
    });
    await hooks.dispose?.();
  });

  it("logs diagnostic codes without forwarding worker messages or details", async () => {
    const worker = fakeWorker();
    const log = vi.fn(async () => ({}));
    const plugin = createServerPlugin({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "instance-3",
    });
    const hooks = await plugin(pluginInput(log), options());

    worker.emit({
      type: "diagnostic",
      level: "error",
      code: "ACP_AUTH_REQUIRED",
      message: "secret-token-value",
      details: { apiKey: "secret-token-value" },
    });

    expect(log).toHaveBeenCalledWith({
      body: {
        service: "opencode-acpx",
        level: "error",
        message: "ACP_AUTH_REQUIRED",
      },
      query: { directory: TEST_DIRECTORY },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-token-value");
    await hooks.dispose?.();
  });

  it("routes a correlated built-in question answer back to the worker", async () => {
    const worker = fakeWorker();
    const rawOptions = options();
    const parsed = parsePluginOptions(rawOptions);
    const server = parsed.servers.cursor;
    if (server === undefined) throw new Error("Cursor test server is missing");
    const plugin = createServerPlugin({
      createWorkerClient: () => worker as unknown as WorkerClient,
      pluginInstanceId: () => "instance-question",
    });
    const hooks = await plugin(pluginInput(), rawOptions);
    const chat = {
      sessionID: "oc-question-session",
      agent: "build",
      model: { providerID: "acp.cursor", id: "default" },
      provider: {},
      message: { id: "message-question" },
    };
    await hooks["chat.message"]?.(
      {
        sessionID: "oc-question-session",
        agent: "build",
        model: { providerID: "acp.cursor", modelID: "default" },
        messageID: "message-question",
      },
      { message: chat.message as never, parts: [] },
    );
    await hooks["chat.params"]?.(chat as never, {
      temperature: 0,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: {},
    });
    const sessionKey = await createSessionKey({
      serverId: "cursor",
      server,
      worktree: TEST_DIRECTORY,
      openCodeSessionId: "oc-question-session",
      generation: 0,
    });
    worker.emit({
      type: "interaction.extension",
      interactionId: "question-interaction",
      serverId: "cursor",
      sessionKey,
      expiresAt: Date.now() + 60_000,
      method: "cursor/ask_question",
      params: {
        questions: [
          {
            id: "ship",
            prompt: "Ship now?",
            options: [{ id: "yes", label: "Yes" }],
          },
        ],
      },
    });
    const callID = `opencode-acpx-question:${Buffer.from(
      "question-interaction",
      "utf8",
    ).toString("base64url")}`;
    await hooks["tool.execute.before"]?.(
      {
        tool: "question",
        sessionID: "oc-question-session",
        callID,
      },
      { args: { questions: [] } },
    );
    await hooks["tool.execute.after"]?.(
      {
        tool: "question",
        sessionID: "oc-question-session",
        callID,
        args: { questions: [] },
      },
      { title: "Question", output: "", metadata: { answers: [["Yes"]] } },
    );

    expect(worker.respondExtension).toHaveBeenCalledWith({
      interactionId: "question-interaction",
      result: {
        outcome: {
          outcome: "answered",
          answers: [{ questionId: "ship", selectedOptionIds: ["yes"] }],
        },
      },
    });
    await hooks.dispose?.();
  });
});
