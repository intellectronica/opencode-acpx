import type {
  JSONObject,
  JSONValue,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import type { AcpRuntimeEvent } from "acpx/runtime";

type ToolEvent = Extract<AcpRuntimeEvent, { type: "tool_call" }>;

export type NativeToolPresentation =
  | "bash"
  | "edit"
  | "glob"
  | "grep"
  | "list"
  | "read"
  | "skill"
  | "task"
  | "todowrite"
  | "webfetch"
  | "websearch"
  | "write"
  | "generic";

export interface ToolProjection {
  name: string;
  presentation: NativeToolPresentation;
  input: Record<string, JSONValue>;
}

export interface ToolResultProjection {
  result: NonNullable<JSONValue>;
  providerMetadata: SharedV3ProviderMetadata;
}

export interface SubagentProjection {
  action: "start" | "progress" | "finish";
  toolCallId: string;
  input: Record<string, JSONValue>;
  result?: NonNullable<JSONValue>;
  isError?: boolean;
}

export function jsonValue(value: unknown): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isRecord(value)) {
    const result: Record<string, JSONValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        item !== undefined &&
        typeof item !== "function" &&
        typeof item !== "symbol"
      ) {
        result[key] = jsonValue(item);
      }
    }
    return result;
  }
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "symbol";
  return "unsupported";
}

export function projectToolCall(event: ToolEvent): ToolProjection {
  const raw = isRecord(event.rawInput) ? event.rawInput : {};
  const subagent = subagentInput(raw, event);
  if (subagent !== undefined)
    return { name: "task", presentation: "task", input: subagent };

  const specialised = specialisedTool(raw, event);
  if (specialised !== undefined) return specialised;

  switch (event.kind) {
    case "execute":
      return {
        name: "bash",
        presentation: "bash",
        input: compact({
          command:
            firstString(raw, ["command", "cmd", "script"]) ?? event.title,
          description: firstString(raw, ["description"]),
        }),
      };
    case "read":
      if (looksLikeList(raw, event)) {
        return {
          name: "list",
          presentation: "list",
          input: compact({ path: toolPath(raw, event) }),
        };
      }
      return {
        name: "read",
        presentation: "read",
        input: compact({
          filePath: toolPath(raw, event),
          offset: firstNumber(raw, ["offset", "line", "startLine"]),
          limit: firstNumber(raw, ["limit", "lineLimit"]),
        }),
      };
    case "search":
      return searchProjection(raw, event);
    case "edit":
      return editProjection(raw, event);
    case "fetch":
      return fetchProjection(raw, event);
    default:
      return {
        name: `acp_${event.kind ?? "tool"}`,
        presentation: "generic",
        input:
          Object.keys(raw).length > 0
            ? (jsonValue(raw) as Record<string, JSONValue>)
            : compact({ summary: event.text || event.title }),
      };
  }
}

export function projectToolResult(
  projection: ToolProjection,
  event: ToolEvent,
): ToolResultProjection {
  const result = nativeResult(projection, event);
  return {
    result,
    providerMetadata: {
      opencodeAcpx: jsonValue({
        acp: {
          kind: event.kind,
          title: event.title,
          status: event.status,
          locations: event.locations,
          rawOutput: event.rawOutput,
          content: event.content,
        },
      }) as JSONObject,
    },
  };
}

export function projectSubagentNotification(
  method: string,
  params: unknown,
): SubagentProjection | undefined {
  if (!isRecord(params)) return undefined;
  if (method === "cursor/task") return cursorTask(params);
  if (
    method === "x.ai/session_notification" ||
    method === "x.ai/session/update"
  )
    return grokSubagent(params);
  return undefined;
}

function specialisedTool(
  raw: Record<string, unknown>,
  event: ToolEvent,
): ToolProjection | undefined {
  const nativeName = firstString(raw, ["_toolName", "toolName", "tool_name"]);
  const lowered = nativeName?.toLowerCase();
  if (lowered === "updatetodos" || lowered === "todowrite") {
    return {
      name: "todowrite",
      presentation: "todowrite",
      input: compact({ todos: raw.todos }),
    };
  }
  if (lowered === "skill" || ("skill" in raw && event.kind === "other")) {
    return {
      name: "skill",
      presentation: "skill",
      input: compact({ name: firstString(raw, ["skill", "name"]) }),
    };
  }
  return undefined;
}

function searchProjection(
  raw: Record<string, unknown>,
  event: ToolEvent,
): ToolProjection {
  const url = firstString(raw, ["url"]);
  const webQuery = firstString(raw, ["searchTerm", "search_term"]);
  if (url !== undefined || webQuery !== undefined) {
    return url === undefined
      ? {
          name: "websearch",
          presentation: "websearch",
          input: compact({ query: webQuery }),
        }
      : {
          name: "webfetch",
          presentation: "webfetch",
          input: compact({ url }),
        };
  }
  if (looksLikeList(raw, event)) {
    return {
      name: "list",
      presentation: "list",
      input: compact({ path: toolPath(raw, event) }),
    };
  }
  const glob = firstString(raw, ["globPattern", "glob_pattern", "glob"]);
  const pattern = firstString(raw, ["pattern"]);
  if (glob !== undefined || looksLikeGlob(event.title)) {
    return {
      name: "glob",
      presentation: "glob",
      input: compact({
        pattern: glob ?? pattern ?? titleSubject(event.title, ["find", "glob"]),
        path: toolPath(raw, event),
      }),
    };
  }
  return {
    name: "grep",
    presentation: "grep",
    input: compact({
      pattern:
        pattern ??
        firstString(raw, ["query", "search", "searchQuery"]) ??
        titleSubject(event.title, ["search", "grep"]),
      path: toolPath(raw, event),
      include: firstString(raw, ["include", "type"]),
    }),
  };
}

function editProjection(
  raw: Record<string, unknown>,
  event: ToolEvent,
): ToolProjection {
  const filePath = toolPath(raw, event);
  const content = firstString(raw, ["content"]);
  const oldString = firstString(raw, ["oldString", "old_string", "oldText"]);
  const newString = firstString(raw, ["newString", "new_string", "newText"]);
  const write =
    (content !== undefined && oldString === undefined) ||
    event.title?.trim().toLowerCase().startsWith("write ") === true;
  return write
    ? {
        name: "write",
        presentation: "write",
        input: compact({ filePath, content }),
      }
    : {
        name: "edit",
        presentation: "edit",
        input: compact({ filePath, oldString, newString }),
      };
}

function fetchProjection(
  raw: Record<string, unknown>,
  event: ToolEvent,
): ToolProjection {
  const query = firstString(raw, ["query", "searchTerm", "search_term"]);
  const url = firstString(raw, ["url", "uri"]);
  if (query !== undefined && url === undefined) {
    return {
      name: "websearch",
      presentation: "websearch",
      input: compact({ query }),
    };
  }
  return {
    name: "webfetch",
    presentation: "webfetch",
    input: compact({ url: url ?? titleUrl(event.title) }),
  };
}

function subagentInput(
  raw: Record<string, unknown>,
  event: ToolEvent,
): Record<string, JSONValue> | undefined {
  const explicitName = firstString(raw, ["_toolName", "toolName", "tool_name"]);
  const activity = firstString(raw, ["activityKind"]);
  const agentPath = firstString(raw, ["agentPath"]);
  const receivers = Array.isArray(raw.receiverThreadIds)
    ? raw.receiverThreadIds
    : undefined;
  const prompt = firstString(raw, ["prompt", "task", "instructions"]);
  const description = firstString(raw, ["description", "subject"]);
  const rawType = raw.subagentType ?? raw.subagent_type ?? raw.agentType;
  const subagentType = subagentTypeValue(rawType);
  const recognised =
    explicitName?.toLowerCase() === "task" ||
    (activity !== undefined && agentPath !== undefined) ||
    (receivers !== undefined && prompt !== undefined) ||
    (prompt !== undefined &&
      description !== undefined &&
      (event.kind === "think" || event.kind === "other")) ||
    (prompt !== undefined && subagentType !== undefined);
  if (!recognised) return undefined;
  return compact({
    prompt,
    description:
      description ??
      event.title ??
      (activity === undefined ? undefined : `${activity} subagent`),
    subagent_type:
      subagentType ??
      (agentPath === undefined
        ? undefined
        : agentPath.split("/").filter(Boolean).at(-1)) ??
      (receivers === undefined ? undefined : "collaboration"),
  });
}

function nativeResult(
  projection: ToolProjection,
  event: ToolEvent,
): NonNullable<JSONValue> {
  if (projection.presentation === "bash") return shellOutput(event);
  if (
    projection.presentation === "grep" ||
    projection.presentation === "glob" ||
    projection.presentation === "list"
  ) {
    return displayOutput(event);
  }
  if (projection.presentation === "edit") {
    const diff = diffContent(event) ?? {
      file: projection.input.filePath,
      before: projection.input.oldString,
      after: projection.input.newString,
    };
    return nonNullJsonValue({ filediff: diff });
  }
  if (projection.presentation === "read") {
    const path = projection.input.filePath;
    return nonNullJsonValue({ loaded: typeof path === "string" ? [path] : [] });
  }
  if (projection.presentation === "task") {
    return nonNullJsonValue({
      background: backgroundFlag(event.rawInput, event.rawOutput),
      acp: event.rawOutput ?? displayOutput(event),
    });
  }
  const output = event.rawOutput ?? contentValue(event.content) ?? event.text;
  return nonNullJsonValue(output);
}

function shellOutput(event: ToolEvent): string {
  if (typeof event.rawOutput === "string") return event.rawOutput;
  if (isRecord(event.rawOutput)) {
    const stdout = firstString(event.rawOutput, ["stdout", "output", "text"]);
    const stderr = firstString(event.rawOutput, ["stderr"]);
    if (stdout !== undefined || stderr !== undefined)
      return [stdout, stderr]
        .filter((value) => value !== undefined && value.length > 0)
        .join("\n");
  }
  return displayOutput(event);
}

function displayOutput(event: ToolEvent): string {
  const content = contentText(event.content);
  if (content.length > 0) return content;
  if (typeof event.rawOutput === "string") return event.rawOutput;
  if (event.rawOutput !== undefined)
    return JSON.stringify(jsonValue(event.rawOutput), null, 2);
  return event.text;
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const result: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.type === "content" && isRecord(item.content)) {
      const text = firstString(item.content, ["text"]);
      if (text !== undefined) result.push(text);
    } else if (item.type === "diff") {
      const path = firstString(item, ["path"]);
      if (path !== undefined) result.push(`Changed ${path}`);
    }
  }
  return result.join("\n");
}

function contentValue(value: unknown): unknown {
  const text = contentText(value);
  return text.length > 0 ? text : value;
}

function diffContent(
  event: ToolEvent,
): { file?: unknown; before?: unknown; after?: unknown } | undefined {
  if (!Array.isArray(event.content)) return undefined;
  for (const item of event.content) {
    if (!isRecord(item) || item.type !== "diff") continue;
    return {
      file: item.path,
      before: item.oldText,
      after: item.newText,
    };
  }
  return undefined;
}

function cursorTask(
  params: Record<string, unknown>,
): SubagentProjection | undefined {
  const toolCallId = firstString(params, ["toolCallId"]);
  if (toolCallId === undefined) return undefined;
  return {
    action: "finish",
    toolCallId,
    input: compact({
      prompt: firstString(params, ["prompt"]),
      description: firstString(params, ["description"]),
      subagent_type: subagentTypeValue(params.subagentType),
    }),
    result: nonNullJsonValue({
      model: params.model,
      agentId: params.agentId,
      durationMs: params.durationMs,
    }),
  };
}

function grokSubagent(
  params: Record<string, unknown>,
): SubagentProjection | undefined {
  const update = isRecord(params.update) ? params.update : params;
  const tag = firstString(update, ["sessionUpdate", "session_update"]);
  const toolCallId = firstString(update, ["subagent_id", "subagentId"]);
  if (toolCallId === undefined || tag === undefined) return undefined;
  if (tag === "subagent_spawned") {
    return {
      action: "start",
      toolCallId,
      input: compact({
        description: firstString(update, ["description"]),
        subagent_type: firstString(update, ["subagent_type", "subagentType"]),
        prompt: firstString(update, ["description"]),
      }),
    };
  }
  if (tag === "subagent_progress") {
    return {
      action: "progress",
      toolCallId,
      input: compact({
        description: "Subagent activity",
        subagent_type: "grok",
      }),
    };
  }
  if (tag !== "subagent_finished") return undefined;
  const status = firstString(update, ["status"]);
  return {
    action: "finish",
    toolCallId,
    input: compact({ description: "Subagent activity", subagent_type: "grok" }),
    result: nonNullJsonValue({
      status,
      error: update.error,
      output: update.output,
      toolCalls: update.tool_calls ?? update.toolCalls,
      turns: update.turns,
      durationMs: update.duration_ms ?? update.durationMs,
      tokensUsed: update.tokens_used ?? update.tokensUsed,
      acpChildSessionId: update.child_session_id ?? update.childSessionId,
    }),
    isError: status === "failed",
  };
}

function subagentTypeValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (isRecord(value)) return firstString(value, ["custom", "name", "type"]);
  return undefined;
}

function backgroundFlag(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const key of ["background", "isBackground", "run_in_background"]) {
      if (typeof value[key] === "boolean") return value[key];
    }
  }
  return undefined;
}

function toolPath(
  raw: Record<string, unknown>,
  event: ToolEvent,
): string | undefined {
  const direct = firstString(raw, ["filePath", "file_path", "path", "cwd"]);
  if (direct !== undefined) return direct;
  if (Array.isArray(event.locations)) {
    for (const location of event.locations) {
      if (!isRecord(location)) continue;
      const path = firstString(location, ["path"]);
      if (path !== undefined) return path;
    }
  }
  return titlePath(event.title);
}

function looksLikeList(
  raw: Record<string, unknown>,
  event: ToolEvent,
): boolean {
  const operation = firstString(raw, ["operation", "action", "_toolName"]);
  return (
    operation?.toLowerCase() === "list" ||
    operation?.toLowerCase() === "ls" ||
    event.title?.trim().toLowerCase().startsWith("list ") === true
  );
}

function looksLikeGlob(title: string | undefined): boolean {
  const value = title?.trim().toLowerCase();
  return (
    value === "find" ||
    value === "glob" ||
    value?.startsWith("find ") === true ||
    value?.startsWith("glob ") === true
  );
}

function titlePath(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const match =
    /^(?:read|write|edit|list(?: files)?(?: in)?)\s+[`'"]?(.+?)[`'"]?(?:\s+\(|$)/i.exec(
      title.trim(),
    );
  const path = match?.[1]?.trim();
  if (path === undefined) return undefined;
  if (["file", "files", "directory"].includes(path.toLowerCase()))
    return undefined;
  return path;
}

function titleSubject(
  title: string | undefined,
  prefixes: string[],
): string | undefined {
  if (title === undefined) return undefined;
  const value = title.trim();
  for (const prefix of prefixes) {
    const match = new RegExp(
      "^" + prefix + "(?: for)?[:\\s]+[`'\"]?(.+?)[`'\"]?$",
      "i",
    ).exec(value);
    if (match?.[1] !== undefined && match[1].toLowerCase() !== "files")
      return match[1];
  }
  return undefined;
}

function titleUrl(title: string | undefined): string | undefined {
  return title?.match(/https?:\/\/\S+/)?.[0];
}

function firstString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.length > 0) return item;
  }
  return undefined;
}

function firstNumber(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item)) return item;
  }
  return undefined;
}

function compact(value: Record<string, unknown>): Record<string, JSONValue> {
  const result: Record<string, JSONValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = jsonValue(item);
  }
  return result;
}

function nonNullJsonValue(value: unknown): NonNullable<JSONValue> {
  return jsonValue(value) ?? { value: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
