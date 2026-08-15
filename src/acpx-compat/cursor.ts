import type {
  CursorAskQuestionRequest,
  CursorAskQuestionResponse,
  CursorCreatePlanRequest,
  CursorCreatePlanResponse,
  CursorPlanPhase,
  CursorQuestion,
  CursorTodo,
  CursorTodoStatus,
} from "./contracts.js";
import { AcpCompatError } from "./errors.js";

export const CURSOR_ASK_QUESTION_METHOD = "cursor/ask_question" as const;
export const CURSOR_CREATE_PLAN_METHOD = "cursor/create_plan" as const;

const CURSOR_TODO_STATUSES = new Set<CursorTodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

export function parseCursorAskQuestionRequest(
  params: unknown,
): CursorAskQuestionRequest {
  const value = requireRecord(params, CURSOR_ASK_QUESTION_METHOD);
  const toolCallId = requireString(
    value.toolCallId,
    "toolCallId",
    CURSOR_ASK_QUESTION_METHOD,
  );
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    throw invalidCursorParams(
      CURSOR_ASK_QUESTION_METHOD,
      "questions must be a non-empty array",
    );
  }
  const questions = value.questions.map((question, index) =>
    parseQuestion(question, index),
  );
  const request: CursorAskQuestionRequest = { toolCallId, questions };
  const title = optionalString(
    value.title,
    "title",
    CURSOR_ASK_QUESTION_METHOD,
  );
  if (title !== undefined) request.title = title;
  return request;
}

export function parseCursorCreatePlanRequest(
  params: unknown,
): CursorCreatePlanRequest {
  const value = requireRecord(params, CURSOR_CREATE_PLAN_METHOD);
  const request: CursorCreatePlanRequest = {
    toolCallId: requireString(
      value.toolCallId,
      "toolCallId",
      CURSOR_CREATE_PLAN_METHOD,
    ),
    plan: requireString(value.plan, "plan", CURSOR_CREATE_PLAN_METHOD),
    todos: parseTodos(value.todos, "todos"),
  };
  const name = optionalString(value.name, "name", CURSOR_CREATE_PLAN_METHOD);
  const overview = optionalString(
    value.overview,
    "overview",
    CURSOR_CREATE_PLAN_METHOD,
  );
  if (name !== undefined) request.name = name;
  if (overview !== undefined) request.overview = overview;
  if (value.isProject !== undefined) {
    if (typeof value.isProject !== "boolean") {
      throw invalidCursorParams(
        CURSOR_CREATE_PLAN_METHOD,
        "isProject must be a boolean",
      );
    }
    request.isProject = value.isProject;
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) {
      throw invalidCursorParams(
        CURSOR_CREATE_PLAN_METHOD,
        "phases must be an array",
      );
    }
    request.phases = value.phases.map((phase, index) =>
      parsePhase(phase, index),
    );
  }
  return request;
}

export function validateCursorAskQuestionResponse(
  response: CursorAskQuestionResponse,
): void {
  const outcome = requireRecord(response.outcome, CURSOR_ASK_QUESTION_METHOD);
  const kind = requireString(
    outcome.outcome,
    "outcome.outcome",
    CURSOR_ASK_QUESTION_METHOD,
  );
  if (kind === "cancelled") return;
  if (kind === "skipped") {
    optionalString(
      outcome.reason,
      "outcome.reason",
      CURSOR_ASK_QUESTION_METHOD,
    );
    return;
  }
  if (kind !== "answered" || !Array.isArray(outcome.answers)) {
    throw invalidCursorParams(
      CURSOR_ASK_QUESTION_METHOD,
      "callback returned an invalid outcome",
    );
  }
  for (const [index, answer] of outcome.answers.entries()) {
    const item = requireRecord(answer, CURSOR_ASK_QUESTION_METHOD);
    requireString(
      item.questionId,
      `outcome.answers[${String(index)}].questionId`,
      CURSOR_ASK_QUESTION_METHOD,
    );
    if (
      !Array.isArray(item.selectedOptionIds) ||
      !item.selectedOptionIds.every(isNonEmptyString)
    ) {
      throw invalidCursorParams(
        CURSOR_ASK_QUESTION_METHOD,
        `outcome.answers[${String(index)}].selectedOptionIds must contain strings`,
      );
    }
  }
}

export function validateCursorCreatePlanResponse(
  response: CursorCreatePlanResponse,
): void {
  const outcome = requireRecord(response.outcome, CURSOR_CREATE_PLAN_METHOD);
  const kind = requireString(
    outcome.outcome,
    "outcome.outcome",
    CURSOR_CREATE_PLAN_METHOD,
  );
  if (kind === "cancelled") return;
  if (kind === "rejected") {
    optionalString(outcome.reason, "outcome.reason", CURSOR_CREATE_PLAN_METHOD);
    return;
  }
  if (kind !== "accepted") {
    throw invalidCursorParams(
      CURSOR_CREATE_PLAN_METHOD,
      "callback returned an invalid outcome",
    );
  }
  optionalString(outcome.planUri, "outcome.planUri", CURSOR_CREATE_PLAN_METHOD);
}

function parseQuestion(value: unknown, index: number): CursorQuestion {
  const record = requireRecord(value, CURSOR_ASK_QUESTION_METHOD);
  if (!Array.isArray(record.options) || record.options.length === 0) {
    throw invalidCursorParams(
      CURSOR_ASK_QUESTION_METHOD,
      `questions[${String(index)}].options must be a non-empty array`,
    );
  }
  const question: CursorQuestion = {
    id: requireString(
      record.id,
      `questions[${String(index)}].id`,
      CURSOR_ASK_QUESTION_METHOD,
    ),
    prompt: requireString(
      record.prompt,
      `questions[${String(index)}].prompt`,
      CURSOR_ASK_QUESTION_METHOD,
    ),
    options: record.options.map((option, optionIndex) => {
      const item = requireRecord(option, CURSOR_ASK_QUESTION_METHOD);
      return {
        id: requireString(
          item.id,
          `questions[${String(index)}].options[${String(optionIndex)}].id`,
          CURSOR_ASK_QUESTION_METHOD,
        ),
        label: requireString(
          item.label,
          `questions[${String(index)}].options[${String(optionIndex)}].label`,
          CURSOR_ASK_QUESTION_METHOD,
        ),
      };
    }),
  };
  if (record.allowMultiple !== undefined) {
    if (typeof record.allowMultiple !== "boolean") {
      throw invalidCursorParams(
        CURSOR_ASK_QUESTION_METHOD,
        `questions[${String(index)}].allowMultiple must be a boolean`,
      );
    }
    question.allowMultiple = record.allowMultiple;
  }
  return question;
}

function parseTodos(value: unknown, path: string): CursorTodo[] {
  if (!Array.isArray(value)) {
    throw invalidCursorParams(
      CURSOR_CREATE_PLAN_METHOD,
      `${path} must be an array`,
    );
  }
  return value.map((todo, index) => {
    const item = requireRecord(todo, CURSOR_CREATE_PLAN_METHOD);
    const status = requireString(
      item.status,
      `${path}[${String(index)}].status`,
      CURSOR_CREATE_PLAN_METHOD,
    );
    if (!CURSOR_TODO_STATUSES.has(status as CursorTodoStatus)) {
      throw invalidCursorParams(
        CURSOR_CREATE_PLAN_METHOD,
        `${path}[${String(index)}].status is invalid`,
      );
    }
    return {
      id: requireString(
        item.id,
        `${path}[${String(index)}].id`,
        CURSOR_CREATE_PLAN_METHOD,
      ),
      content: requireString(
        item.content,
        `${path}[${String(index)}].content`,
        CURSOR_CREATE_PLAN_METHOD,
      ),
      status: status as CursorTodoStatus,
    };
  });
}

function parsePhase(value: unknown, index: number): CursorPlanPhase {
  const item = requireRecord(value, CURSOR_CREATE_PLAN_METHOD);
  return {
    name: requireString(
      item.name,
      `phases[${String(index)}].name`,
      CURSOR_CREATE_PLAN_METHOD,
    ),
    todos: parseTodos(item.todos, `phases[${String(index)}].todos`),
  };
}

function requireRecord(
  value: unknown,
  method: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidCursorParams(method, "params must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string, method: string): string {
  if (!isNonEmptyString(value))
    throw invalidCursorParams(method, `${path} must be a non-empty string`);
  return value;
}

function optionalString(
  value: unknown,
  path: string,
  method: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, path, method);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidCursorParams(method: string, detail: string): AcpCompatError {
  return new AcpCompatError(
    "ACP_COMPAT_INVALID_PARAMS",
    `${method}: ${detail}`,
    { method },
  );
}
