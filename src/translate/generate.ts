import type {
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  SharedV3Warning,
} from "@ai-sdk/provider";

import { emptyUsage } from "./stream.js";

interface TextAccumulator {
  kind: "text" | "reasoning";
  value: string;
}

export async function collectGenerateResult(
  streamed: LanguageModelV3StreamResult,
): Promise<LanguageModelV3GenerateResult> {
  const content: LanguageModelV3Content[] = [];
  const blocks = new Map<string, TextAccumulator>();
  const warnings: SharedV3Warning[] = [];
  let finishReason: LanguageModelV3GenerateResult["finishReason"] = {
    unified: "error",
    raw: "missing-finish",
  };
  let usage = emptyUsage();
  let response: LanguageModelV3GenerateResult["response"];

  for await (const part of streamed.stream) {
    if (part.type === "stream-start") {
      warnings.push(...part.warnings);
      continue;
    }
    if (part.type === "response-metadata") {
      response = {
        ...(part.id === undefined ? {} : { id: part.id }),
        ...(part.timestamp === undefined ? {} : { timestamp: part.timestamp }),
        ...(part.modelId === undefined ? {} : { modelId: part.modelId }),
      };
      continue;
    }
    if (part.type === "text-start") {
      blocks.set(part.id, { kind: "text", value: "" });
      continue;
    }
    if (part.type === "reasoning-start") {
      blocks.set(part.id, { kind: "reasoning", value: "" });
      continue;
    }
    if (part.type === "text-delta" || part.type === "reasoning-delta") {
      const block = blocks.get(part.id);
      if (block !== undefined) block.value += part.delta;
      continue;
    }
    if (part.type === "text-end" || part.type === "reasoning-end") {
      const block = blocks.get(part.id);
      if (block !== undefined) {
        content.push(
          block.kind === "text"
            ? { type: "text", text: block.value }
            : { type: "reasoning", text: block.value },
        );
        blocks.delete(part.id);
      }
      continue;
    }
    if (part.type === "tool-call" || part.type === "tool-result") {
      content.push(part);
      continue;
    }
    if (
      part.type === "file" ||
      part.type === "source" ||
      part.type === "tool-approval-request"
    ) {
      content.push(part);
      continue;
    }
    if (part.type === "finish") {
      finishReason = part.finishReason;
      usage = part.usage;
    }
  }

  const result: LanguageModelV3GenerateResult = {
    content,
    finishReason,
    usage,
    warnings,
    ...(streamed.request === undefined ? {} : { request: streamed.request }),
    ...(response === undefined && streamed.response === undefined
      ? {}
      : { response: { ...response, ...streamed.response } }),
  };
  return result;
}

export function isTerminalPart(part: LanguageModelV3StreamPart): boolean {
  return part.type === "finish";
}
