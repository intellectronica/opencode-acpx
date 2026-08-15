import type { AcpRuntimeEvent } from "acpx/runtime";
import { describe, expect, it } from "vitest";

import {
  mergeTodoProjection,
  projectPlanUpdate,
  projectSubagentNotification,
  projectTodoNotification,
  projectToolCall,
  projectToolResult,
} from "../../src/translate/tools.js";

type ToolEvent = Extract<AcpRuntimeEvent, { type: "tool_call" }>;

function tool(overrides: Partial<ToolEvent>): ToolEvent {
  return { type: "tool_call", text: "Tool activity", ...overrides };
}

describe("native OpenCode tool projection", () => {
  it("projects standard ACP execution as a native shell card with readable output", () => {
    const start = tool({
      kind: "execute",
      title: "Run tests",
      rawInput: { command: "pnpm test", description: "Run the test suite" },
    });
    const projection = projectToolCall(start);
    expect(projection).toEqual({
      name: "bash",
      presentation: "bash",
      input: { command: "pnpm test", description: "Run the test suite" },
    });
    expect(
      projectToolResult(projection, {
        ...start,
        status: "completed",
        rawOutput: { stdout: "ok", stderr: "warning", exitCode: 0 },
      }).result,
    ).toBe("ok\nwarning");
  });

  it("projects standard read, grep, glob, list, edit, write and web tools", () => {
    expect(
      projectToolCall(
        tool({
          kind: "read",
          rawInput: { file_path: "src/index.ts", offset: 4 },
        }),
      ),
    ).toMatchObject({
      name: "read",
      input: { filePath: "src/index.ts", offset: 4 },
    });
    expect(
      projectToolCall(tool({ kind: "read", title: "Read File", rawInput: {} }))
        .input,
    ).not.toHaveProperty("filePath");
    expect(
      projectToolCall(
        tool({ kind: "search", rawInput: { pattern: "TODO", path: "src" } }),
      ),
    ).toMatchObject({ name: "grep", input: { pattern: "TODO", path: "src" } });
    expect(
      projectToolCall(tool({ kind: "search", title: "Find", rawInput: {} })),
    ).toMatchObject({ name: "glob" });
    expect(
      projectToolCall(
        tool({
          kind: "search",
          rawInput: { globPattern: "**/*.ts", path: "src" },
        }),
      ),
    ).toMatchObject({
      name: "glob",
      input: { pattern: "**/*.ts", path: "src" },
    });
    expect(
      projectToolCall(
        tool({
          kind: "read",
          title: "List files in src",
          rawInput: { path: "src" },
        }),
      ),
    ).toMatchObject({ name: "list", input: { path: "src" } });
    expect(
      projectToolCall(
        tool({
          kind: "edit",
          rawInput: {
            file_path: "src/index.ts",
            old_string: "old",
            new_string: "new",
          },
        }),
      ),
    ).toMatchObject({
      name: "edit",
      input: { filePath: "src/index.ts", oldString: "old", newString: "new" },
    });
    expect(
      projectToolCall(
        tool({
          kind: "edit",
          title: "Write notes.md",
          rawInput: { path: "notes.md", content: "hi" },
        }),
      ),
    ).toMatchObject({
      name: "write",
      input: { filePath: "notes.md", content: "hi" },
    });
    expect(
      projectToolCall(
        tool({ kind: "fetch", rawInput: { url: "https://example.com" } }),
      ),
    ).toMatchObject({
      name: "webfetch",
      input: { url: "https://example.com" },
    });
    expect(
      projectToolCall(
        tool({ kind: "fetch", rawInput: { query: "ACP protocol" } }),
      ),
    ).toMatchObject({ name: "websearch", input: { query: "ACP protocol" } });
  });

  it("builds OpenCode filediff metadata from ACP diff content", () => {
    const event = tool({
      kind: "edit",
      rawInput: { path: "src/a.ts", old_string: "a", new_string: "b" },
      content: [{ type: "diff", path: "src/a.ts", oldText: "a", newText: "b" }],
    });
    const result = projectToolResult(projectToolCall(event), event);
    expect(result.result).toEqual({
      filediff: { file: "src/a.ts", before: "a", after: "b" },
    });
  });

  it("recognises Cursor, Claude, Codex and generic ACP subagent tool shapes", () => {
    const cases: ToolEvent[] = [
      tool({
        kind: "other",
        rawInput: {
          _toolName: "task",
          prompt: "Inspect the project",
          description: "Explore",
          subagentType: "explore",
        },
      }),
      tool({
        kind: "think",
        rawInput: {
          prompt: "Review this change",
          description: "Reviewer",
          subagent_type: "general-purpose",
        },
      }),
      tool({
        kind: "other",
        title: "Start subagent explorer",
        rawInput: {
          agentThreadId: "thread-1",
          agentPath: "agents/explorer",
          activityKind: "started",
        },
      }),
      tool({
        kind: "other",
        title: "Collaborate",
        rawInput: {
          prompt: "Investigate in parallel",
          receiverThreadIds: ["thread-2"],
          agentsStates: {},
        },
      }),
    ];
    expect(cases.map((event) => projectToolCall(event).name)).toEqual([
      "task",
      "task",
      "task",
      "task",
    ]);
    const cursor = cases[0];
    const codex = cases[2];
    if (cursor === undefined || codex === undefined)
      throw new Error("missing subagent fixture");
    expect(projectToolCall(cursor).input).toMatchObject({
      description: "Explore",
      subagent_type: "explore",
    });
    expect(projectToolCall(codex).input).toMatchObject({
      subagent_type: "explorer",
    });
  });

  it("keeps unsupported standard kinds provider-executed under a safe ACP name", () => {
    expect(
      projectToolCall(tool({ kind: "delete", rawInput: { path: "old.txt" } })),
    ).toMatchObject({ name: "acp_delete", presentation: "generic" });
  });
});

describe("vendor subagent lifecycle projection", () => {
  it("uses Cursor task completion metadata as a native task fallback", () => {
    expect(
      projectSubagentNotification("cursor/task", {
        toolCallId: "task-1",
        description: "Explore",
        prompt: "Inspect files",
        subagentType: "explore",
        model: "gpt-5",
        agentId: "cursor-agent-1",
        durationMs: 1200,
      }),
    ).toMatchObject({
      action: "finish",
      toolCallId: "task-1",
      input: { description: "Explore", subagent_type: "explore" },
      result: { model: "gpt-5", agentId: "cursor-agent-1", durationMs: 1200 },
    });
  });

  it("projects Grok spawn, progress and finish notifications", () => {
    const spawn = projectSubagentNotification("x.ai/session_notification", {
      sessionId: "parent",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "sub-1",
        description: "Research",
        subagent_type: "explore",
      },
    });
    const progress = projectSubagentNotification("x.ai/session_notification", {
      sessionId: "parent",
      update: { sessionUpdate: "subagent_progress", subagent_id: "sub-1" },
    });
    const finish = projectSubagentNotification("x.ai/session_notification", {
      sessionId: "parent",
      update: {
        sessionUpdate: "subagent_finished",
        subagent_id: "sub-1",
        child_session_id: "child-1",
        status: "completed",
        output: "Done",
        tool_calls: 3,
        turns: 2,
      },
    });
    expect(spawn).toMatchObject({ action: "start", toolCallId: "sub-1" });
    expect(progress).toMatchObject({ action: "progress", toolCallId: "sub-1" });
    expect(finish).toMatchObject({
      action: "finish",
      toolCallId: "sub-1",
      result: {
        status: "completed",
        output: "Done",
        toolCalls: 3,
        turns: 2,
        acpChildSessionId: "child-1",
      },
    });
  });
});

describe("native todo projection", () => {
  it("normalises standard ACP plan entries", () => {
    expect(
      projectPlanUpdate({
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Inspect", status: "in_progress", priority: "high" },
            { content: "Ship", status: "completed" },
          ],
        },
      }),
    ).toEqual({
      identity: "plan",
      merge: false,
      todos: [
        { content: "Inspect", status: "in_progress", priority: "high" },
        { content: "Ship", status: "completed", priority: "medium" },
      ],
    });
  });

  it("merges Cursor todo updates by stable ID and preserves cancellation", () => {
    const patch = projectTodoNotification("cursor/update_todos", {
      merge: true,
      todos: [
        {
          id: "two",
          content: "Ship",
          status: "completed",
          _meta: { cancelled: true },
        },
        { id: "three", content: "Verify", status: "pending" },
      ],
    });
    expect(patch).toBeDefined();
    if (patch === undefined) throw new Error("missing todo projection");
    expect(
      mergeTodoProjection(
        [
          {
            sourceId: "one",
            content: "Inspect",
            status: "completed",
            priority: "medium",
          },
          {
            sourceId: "two",
            content: "Ship",
            status: "pending",
            priority: "medium",
          },
        ],
        patch,
      ),
    ).toEqual([
      {
        sourceId: "one",
        content: "Inspect",
        status: "completed",
        priority: "medium",
      },
      {
        sourceId: "two",
        content: "Ship",
        status: "cancelled",
        priority: "medium",
      },
      {
        sourceId: "three",
        content: "Verify",
        status: "pending",
        priority: "medium",
      },
    ]);
  });
});
