#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

let nextSession = 1;
let nextRequest = 1;
const sessions = new Map();
const pending = new Map();
const persistentStatePath = process.env.FAKE_ACP_STATE;

if (persistentStatePath) {
  try {
    const saved = JSON.parse(readFileSync(persistentStatePath, "utf8"));
    for (const [sessionId, session] of Object.entries(saved.sessions ?? {})) {
      sessions.set(sessionId, { ...session, cancelWaiter: undefined });
      const sequence = Number(sessionId.match(/(\d+)$/)?.[1] ?? 0);
      nextSession = Math.max(nextSession, sequence + 1);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function persistSessions() {
  if (!persistentStatePath) return;
  mkdirSync(dirname(persistentStatePath), { recursive: true });
  const serialised = Object.fromEntries(
    [...sessions.entries()].map(([sessionId, session]) => [
      sessionId,
      { ...session, cancelWaiter: undefined },
    ]),
  );
  writeFileSync(
    persistentStatePath,
    `${JSON.stringify({ sessions: serialised }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function update(sessionId, updateValue) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: updateValue },
  });
}

function configOptions(model = "fake-default", mode = "agent") {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: model,
      options: [
        { value: "fake-default", name: "Fake Default" },
        { value: "fake-reasoning", name: "Fake Reasoning" },
      ],
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: mode,
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
      ],
    },
  ];
}

async function requestClient(method, params) {
  const id = `fake-client-${nextRequest++}`;
  const result = new Promise((resolve, reject) =>
    pending.set(id, { resolve, reject }),
  );
  write({ jsonrpc: "2.0", id, method, params });
  return result;
}

function promptText(params) {
  return params.prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function handlePrompt(id, params) {
  const session = sessions.get(params.sessionId);
  if (!session) {
    fail(id, -32602, "unknown session");
    return;
  }

  const text = promptText(params);
  session.turns += 1;
  session.cancelled = false;
  persistSessions();
  update(params.sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      {
        name: "fixture",
        description: "Run the fixture command",
        input: { hint: "text" },
      },
    ],
  });
  update(params.sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: `thought:${session.turns}` },
  });

  if (text.includes("wait-cancel")) {
    await new Promise((resolve) => {
      session.cancelWaiter = resolve;
      setTimeout(resolve, 30_000).unref();
    });
    reply(id, { stopReason: session.cancelled ? "cancelled" : "end_turn" });
    return;
  }

  if (text.includes("permission")) {
    const outcome = await requestClient("session/request_permission", {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: `permission-tool-${session.turns}`,
        title: "Write fixture file",
        kind: "edit",
        status: "pending",
        rawInput: { path: "/tmp/fake-acp-fixture" },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        {
          optionId: "allow-always",
          name: "Always allow",
          kind: "allow_always",
        },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const selected =
      outcome?.outcome?.outcome === "selected"
        ? outcome.outcome.optionId
        : undefined;
    update(params.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: selected ? `permission:${selected}` : "permission:cancelled",
      },
    });
  }

  const toolCallId = `remote-tool-${session.turns}`;
  update(params.sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: "Inspect fixture",
    kind: "read",
    status: "in_progress",
    rawInput: { query: text },
  });
  update(params.sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    rawOutput: { ok: true, turn: session.turns },
  });
  update(params.sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `echo:${text}` },
  });
  update(params.sessionId, {
    sessionUpdate: "usage_update",
    used: session.turns * 10,
    size: 1000,
    _meta: {
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        thoughtTokens: 1,
        totalTokens: 9,
      },
    },
  });
  reply(id, { stopReason: session.cancelled ? "cancelled" : "end_turn" });
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "opencode-acpx-fixture", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: true,
            audio: true,
            embeddedContext: false,
          },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, close: {}, resume: {} },
        },
        authMethods: [],
      });
      return;
    case "session/new": {
      const sessionId = `fixture-session-${nextSession++}`;
      sessions.set(sessionId, {
        cwd: message.params.cwd,
        turns: 0,
        model: "fake-default",
        mode: "agent",
        cancelled: false,
        cancelWaiter: undefined,
      });
      persistSessions();
      reply(message.id, { sessionId, configOptions: configOptions() });
      update(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "fixture",
            description: "Run the fixture command",
            input: { hint: "text" },
          },
        ],
      });
      return;
    }
    case "session/load":
    case "session/resume": {
      const session = sessions.get(message.params.sessionId);
      if (!session) {
        fail(message.id, -32602, "unknown session");
        return;
      }
      reply(message.id, {
        configOptions: configOptions(session.model, session.mode),
      });
      return;
    }
    case "session/prompt":
      await handlePrompt(message.id, message.params);
      return;
    case "session/set_config_option": {
      const session = sessions.get(message.params.sessionId);
      if (!session) {
        fail(message.id, -32602, "unknown session");
        return;
      }
      if (message.params.configId === "model")
        session.model = message.params.value;
      if (message.params.configId === "mode")
        session.mode = message.params.value;
      persistSessions();
      reply(message.id, {
        configOptions: configOptions(session.model, session.mode),
      });
      return;
    }
    case "session/set_mode": {
      const session = sessions.get(message.params.sessionId);
      if (session) session.mode = message.params.modeId;
      persistSessions();
      reply(message.id, {});
      return;
    }
    case "session/list":
      reply(message.id, {
        sessions: [...sessions.entries()].map(([sessionId, session]) => ({
          sessionId,
          cwd: session.cwd,
          title: "Fixture session",
        })),
      });
      return;
    case "session/close":
      reply(message.id, {});
      return;
    default:
      fail(message.id, -32601, `unsupported fixture method: ${message.method}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === "session/cancel") {
    const session = sessions.get(message.params.sessionId);
    if (session) {
      session.cancelled = true;
      session.cancelWaiter?.();
      session.cancelWaiter = undefined;
    }
    return;
  }
  if (message.id !== undefined) void handleRequest(message);
});
