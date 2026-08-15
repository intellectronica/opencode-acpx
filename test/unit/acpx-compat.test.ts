import type {
  AuthMethod,
  CreateElicitationRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
} from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";

import {
  AcpCompatBroker,
  AcpCompatError,
  createAcpCompatFacade,
  createAcpxCompatibilityReport,
  isAcpCompatFacade,
  type AcpCompatAuthMetadata,
  type AcpCompatCommandUpdate,
  type AcpCompatCursorPlan,
  type AcpCompatCursorQuestion,
  type AcpCompatElicitation,
} from "../../src/acpx-compat/index.js";

const ROUTE = {
  serverId: "cursor",
  sessionKey: "session-1",
  turnId: "turn-1",
} as const;

describe("AcpCompatBroker", () => {
  it("routes standard ACP elicitation with deterministic interaction metadata", async () => {
    const onElicitation = vi.fn((_event: AcpCompatElicitation) => {
      void _event;
      return {
        action: "accept" as const,
        content: { branch: "main" },
      };
    });
    const broker = new AcpCompatBroker({
      callbacks: { onElicitation },
      now: () => 42,
      createInteractionId: (sequence) => `interaction-${String(sequence)}`,
    });
    const request: CreateElicitationRequest = {
      mode: "form",
      sessionId: "backend-1",
      message: "Choose a branch",
      requestedSchema: {
        type: "object",
        properties: { branch: { type: "string" } },
      },
    };

    await expect(broker.handleElicitation(request, ROUTE)).resolves.toEqual({
      action: "accept",
      content: { branch: "main" },
    });
    const elicitation = onElicitation.mock.calls[0]?.[0];
    expect(elicitation?.request).toBe(request);
    expect(elicitation?.context).toMatchObject({
      ...ROUTE,
      interactionId: "interaction-1",
      sequence: 1,
      receivedAt: 42,
    });
    expect(elicitation?.context.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed when elicitation is unsupported, aborted, or times out", async () => {
    const unsupported = new AcpCompatBroker();
    const request = {
      mode: "url",
      sessionId: "backend-1",
      message: "Sign in",
      url: "https://example.test/login",
      elicitationId: "login-1",
    } as CreateElicitationRequest;
    await expect(
      unsupported.handleElicitation(request, ROUTE),
    ).resolves.toEqual({ action: "cancel" });
    expect(unsupported.diagnostics.at(-1)?.code).toBe(
      "UNSUPPORTED_ELICITATION",
    );

    const callback = vi.fn(() => new Promise<never>(() => undefined));
    const aborted = new AcpCompatBroker({
      callbacks: { onElicitation: callback },
    });
    const controller = new AbortController();
    controller.abort(new Error("turn cancelled"));
    await expect(
      aborted.handleElicitation(request, ROUTE, { signal: controller.signal }),
    ).resolves.toEqual({ action: "cancel" });
    expect(callback).not.toHaveBeenCalled();
    expect(aborted.diagnostics.at(-1)?.code).toBe("INTERACTION_ABORTED");

    vi.useFakeTimers();
    try {
      const timedOut = new AcpCompatBroker({
        callbacks: { onElicitation: callback },
        interactionTimeoutMs: 10,
      });
      const result = timedOut.handleElicitation(request, ROUTE);
      await vi.advanceTimersByTimeAsync(10);
      await expect(result).resolves.toEqual({ action: "cancel" });
      expect(timedOut.diagnostics.at(-1)?.code).toBe("INTERACTION_TIMED_OUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes arbitrary reverse requests and reports JSON-RPC method-not-found", async () => {
    const onReverseRequest = vi.fn(({ params }: { params: unknown }) => ({
      echoed: params,
    }));
    const broker = new AcpCompatBroker({ callbacks: { onReverseRequest } });

    await expect(
      broker.handleReverseRequest("vendor.example/choose", { value: 3 }, ROUTE),
    ).resolves.toEqual({ echoed: { value: 3 } });

    const unsupported = new AcpCompatBroker();
    const failure = await unsupported
      .handleReverseRequest("vendor.example/unknown", {}, ROUTE)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpCompatError);
    expect((failure as AcpCompatError).toJsonRpcError()).toEqual({
      code: -32601,
      message: "Unsupported ACP reverse request: vendor.example/unknown",
      data: {
        compatibilityCode: "ACP_COMPAT_UNSUPPORTED",
        method: "vendor.example/unknown",
      },
    });
  });

  it("calls Cursor ask-question and create-plan callbacks using Cursor's nested outcomes", async () => {
    const onCursorQuestion = vi.fn((_event: AcpCompatCursorQuestion) => {
      void _event;
      return {
        outcome: {
          outcome: "answered" as const,
          answers: [{ questionId: "mode", selectedOptionIds: ["plan"] }],
        },
      };
    });
    const onCursorPlan = vi.fn((_event: AcpCompatCursorPlan) => {
      void _event;
      return { outcome: { outcome: "accepted" as const } };
    });
    const broker = new AcpCompatBroker({
      callbacks: { onCursorQuestion, onCursorPlan },
    });

    await expect(
      broker.handleReverseRequest(
        "cursor/ask_question",
        {
          toolCallId: "tool-question",
          title: "Need input",
          questions: [
            {
              id: "mode",
              prompt: "Which mode?",
              options: [
                { id: "agent", label: "Agent" },
                { id: "plan", label: "Plan" },
              ],
              allowMultiple: false,
            },
          ],
        },
        ROUTE,
      ),
    ).resolves.toEqual({
      outcome: {
        outcome: "answered",
        answers: [{ questionId: "mode", selectedOptionIds: ["plan"] }],
      },
    });
    expect(
      onCursorQuestion.mock.calls[0]?.[0].request.questions[0]?.prompt,
    ).toBe("Which mode?");

    await expect(
      broker.handleReverseRequest(
        "cursor/create_plan",
        {
          toolCallId: "tool-plan",
          name: "Compatibility layer",
          plan: "1. Build it\n2. Test it",
          todos: [{ id: "todo-1", content: "Build it", status: "in_progress" }],
        },
        ROUTE,
      ),
    ).resolves.toEqual({ outcome: { outcome: "accepted" } });
    expect(onCursorPlan.mock.calls[0]?.[0].request.plan).toContain("Build it");
  });

  it("rejects malformed Cursor requests before invoking callbacks", async () => {
    const onCursorQuestion = vi.fn(() => ({
      outcome: { outcome: "cancelled" as const },
    }));
    const broker = new AcpCompatBroker({ callbacks: { onCursorQuestion } });

    await expect(
      broker.handleReverseRequest(
        "cursor/ask_question",
        { toolCallId: "tool-question", questions: [] },
        ROUTE,
      ),
    ).rejects.toMatchObject({ code: "ACP_COMPAT_INVALID_PARAMS" });
    expect(onCursorQuestion).not.toHaveBeenCalled();
    expect(broker.diagnostics.at(-1)?.code).toBe("MALFORMED_REVERSE_REQUEST");
  });

  it("isolates notification and raw-message observer failures", async () => {
    const onDiagnostic = vi.fn();
    const broker = new AcpCompatBroker({
      callbacks: {
        onRawMessage: () => {
          throw new Error("raw sink unavailable");
        },
        onReverseNotification: () => {
          throw new Error("notification sink unavailable");
        },
        onDiagnostic,
      },
    });

    await expect(
      broker.observeRawMessage({
        direction: "agent-to-client",
        message: { jsonrpc: "2.0", method: "cursor/task", params: {} },
        context: ROUTE,
      }),
    ).resolves.toBeUndefined();
    await expect(
      broker.observeReverseNotification(
        "cursor/task",
        { toolCallId: "task-1" },
        ROUTE,
      ),
    ).resolves.toBeUndefined();
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    expect(broker.diagnostics.map(({ code }) => code)).toEqual([
      "CALLBACK_FAILED",
      "CALLBACK_FAILED",
    ]);
  });

  it("preserves full command/config updates and marks stock runtime events as reduced", async () => {
    const onCommandUpdate = vi.fn();
    const onConfigUpdate = vi.fn();
    const broker = new AcpCompatBroker({
      callbacks: { onCommandUpdate, onConfigUpdate },
    });
    const commands: SessionNotification = {
      sessionId: "backend-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "compact",
            description: "Compact context",
            input: { hint: "Optional focus" },
            _meta: { vendor: "cursor" },
          },
        ],
      },
    };
    const config: SessionNotification = {
      sessionId: "backend-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            type: "select",
            id: "model",
            name: "Model",
            category: "model",
            currentValue: "composer-2",
            options: [{ value: "composer-2", name: "Composer 2" }],
          },
        ],
      },
    };

    await broker.observeSessionUpdate(commands, ROUTE);
    await broker.observeSessionUpdate(config, ROUTE);
    expect(onCommandUpdate.mock.calls[0]?.[0]).toMatchObject({
      fidelity: "full",
      commands: [
        { input: { hint: "Optional focus" }, _meta: { vendor: "cursor" } },
      ],
    });
    expect(onConfigUpdate.mock.calls[0]?.[0]).toMatchObject({
      fidelity: "full",
      configOptions: [{ id: "model", currentValue: "composer-2" }],
    });

    await broker.observeRuntimeEvent(
      {
        type: "status",
        tag: "available_commands_update",
        text: "available commands updated (1)",
        availableCommands: [
          { name: "compact", description: "Compact context", hasInput: true },
        ],
      },
      ROUTE,
    );
    await broker.observeRuntimeEvent(
      {
        type: "status",
        tag: "config_option_update",
        text: "config options updated",
      },
      ROUTE,
    );
    expect(onCommandUpdate.mock.calls[1]?.[0]).toMatchObject({
      fidelity: "reduced",
      commands: [{ name: "compact", hasInput: true }],
    });
    expect(onConfigUpdate.mock.calls[1]?.[0]).toMatchObject({
      fidelity: "reduced",
      source: "stock-runtime",
    });
    expect(onConfigUpdate.mock.calls[1]?.[0]).not.toHaveProperty(
      "configOptions",
    );
  });

  it("publishes sanitised authentication metadata without credential values", async () => {
    const onAuthMetadata = vi.fn((_metadata: AcpCompatAuthMetadata) => {
      void _metadata;
    });
    const broker = new AcpCompatBroker({
      callbacks: { onAuthMetadata },
      now: () => 100,
    });
    const methods: AuthMethod[] = [
      {
        type: "env_var",
        id: "api-key",
        name: "API key",
        vars: [{ name: "SECRET_TOKEN", secret: true }],
      },
      {
        type: "terminal",
        id: "login",
        name: "Interactive login",
        args: ["login"],
        env: { ACCESS_TOKEN: "must-not-leak" },
      },
    ];

    await broker.observeAuthMetadata(
      { status: "selected", methods, selectedMethodId: "login" },
      ROUTE,
    );
    const metadata = onAuthMetadata.mock.calls[0]?.[0];
    expect(metadata).toMatchObject({
      status: "selected",
      selectedMethodId: "login",
      observedAt: 100,
      methods: [
        {
          variableNames: ["SECRET_TOKEN"],
          secretVariableNames: ["SECRET_TOKEN"],
        },
        { arguments: ["login"], environmentNames: ["ACCESS_TOKEN"] },
      ],
    });
    expect(JSON.stringify(metadata)).not.toContain("must-not-leak");
  });
});

describe("Acp compatibility facade", () => {
  it("reports stock runtime limitations explicitly", () => {
    const report = createAcpxCompatibilityReport(false);
    expect(report.capabilities.standardElicitation.availability).toBe(
      "unavailable",
    );
    expect(report.capabilities.reverseExtensionRequests.availability).toBe(
      "unavailable",
    );
    expect(report.capabilities.commandUpdates.availability).toBe("degraded");
    expect(report.diagnostics.map(({ code }) => code)).toContain(
      "STOCK_ACPX_REVERSE_REQUESTS_UNAVAILABLE",
    );
  });

  it("is detectable, delegates the runtime, and observes stock events", async () => {
    const handle: AcpRuntimeHandle = {
      sessionKey: "session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-1",
      backendSessionId: "backend-1",
    };
    const statusEvent: AcpRuntimeEvent = {
      type: "status",
      tag: "available_commands_update",
      text: "commands",
      availableCommands: [{ name: "compact", hasInput: false }],
    };
    const runtime = createRuntimeStub(handle, statusEvent);
    const onCommandUpdate = vi.fn((_update: AcpCompatCommandUpdate) => {
      void _update;
    });
    const facade = createAcpCompatFacade(runtime, {
      serverId: "cursor",
      callbacks: { onCommandUpdate },
      resolveTurnContext: () => ({ turnId: "turn-1" }),
    });

    expect(isAcpCompatFacade(facade)).toBe(true);
    await expect(
      facade.ensureSession({
        sessionKey: "session-1",
        agent: "cursor",
        mode: "persistent",
      }),
    ).resolves.toBe(handle);
    const turn = facade.startTurn({
      handle,
      text: "hello",
      mode: "prompt",
      requestId: "request-1",
    });
    const events: AcpRuntimeEvent[] = [];
    for await (const event of turn.events) events.push(event);
    expect(events).toEqual([statusEvent]);
    const commandUpdate = onCommandUpdate.mock.calls[0]?.[0];
    expect(commandUpdate?.fidelity).toBe("reduced");
    expect(commandUpdate?.context).toMatchObject({
      serverId: "cursor",
      sessionKey: "session-1",
      backendSessionId: "backend-1",
      turnId: "turn-1",
      requestId: "request-1",
    });
    await expect(turn.result).resolves.toEqual({
      status: "completed",
      stopReason: "end_turn",
    });
  });
});

function createRuntimeStub(
  handle: AcpRuntimeHandle,
  event: AcpRuntimeEvent,
): AcpRuntime {
  const createTurn = (): AcpRuntimeTurn => ({
    requestId: "request-1",
    events: oneEvent(event),
    result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
    cancel: () => Promise.resolve(),
    closeStream: () => Promise.resolve(),
  });
  return {
    ensureSession: () => Promise.resolve(handle),
    startTurn: createTurn,
    runTurn: () => oneEvent(event),
    cancel: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

async function* oneEvent(
  event: AcpRuntimeEvent,
): AsyncIterable<AcpRuntimeEvent> {
  await Promise.resolve();
  yield event;
}
