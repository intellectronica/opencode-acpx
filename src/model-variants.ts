import { createHash } from "node:crypto";

import type { PresetId } from "./config.js";
import type { CatalogueModel } from "./worker/messages.js";

export const ACP_SELECTION_OPTION = "opencodeAcpx";

export type AcpConfigValue = string | boolean;

export interface AcpModelSelection {
  modelId?: string;
  config: Record<string, AcpConfigValue>;
}

export interface AcpModelVariantProjection {
  selection: AcpModelSelection;
}

export interface AcpModelProjection {
  id: string;
  name?: string;
  selection: AcpModelSelection;
  variants: Record<string, AcpModelVariantProjection>;
}

interface ConfigChoice {
  value: AcpConfigValue;
  name: string;
}

interface ConfigAxis {
  id: string;
  name: string;
  currentValue: AcpConfigValue;
  choices: ConfigChoice[];
  primary: boolean;
}

const MAX_GENERATED_VARIANTS = 128;
const CURSOR_PARAMETERISED_MODEL = /^(.*)\[([^\]]+)\]$/u;

const knownVariantIds = new Set([
  "context",
  "context_window",
  "effort",
  "fast",
  "fast-mode",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "thought_level",
]);

/**
 * Projects ACP's session-scoped model and config selectors onto OpenCode's
 * model/variant catalogue. Every generated option retains the exact opaque ACP
 * model/config identifiers required for later session control.
 */
export function projectAcpModels(input: {
  preset: PresetId;
  models: CatalogueModel[];
  currentModelId?: string;
  configOptions: unknown[];
  modelConfigOptions?: Readonly<Record<string, unknown[]>>;
  configuredDefaults?: Record<string, AcpConfigValue>;
}): AcpModelProjection[] {
  if (input.preset !== "cursor") {
    return input.models.map((model) => {
      const projection = configProjection(
        configOptionsForModel(input, model.id),
        input.configuredDefaults,
      );
      return {
        ...model,
        selection: { modelId: model.id, config: projection.baseline },
        variants: variantsWithModelId(projection.variants, model.id),
      };
    });
  }

  return projectCursorModels(input);
}

export function providerSelectionOptions(
  selection: AcpModelSelection,
): Record<string, unknown> {
  return {
    [ACP_SELECTION_OPTION]: {
      ...(selection.modelId === undefined
        ? {}
        : { modelId: selection.modelId }),
      config: selection.config,
    },
  };
}

function projectCursorModels(input: {
  models: CatalogueModel[];
  currentModelId?: string;
  configOptions: unknown[];
  modelConfigOptions?: Readonly<Record<string, unknown[]>>;
  configuredDefaults?: Record<string, AcpConfigValue>;
}): AcpModelProjection[] {
  const groups = new Map<
    string,
    { plain?: CatalogueModel; parameterised: CatalogueModel[] }
  >();
  for (const model of input.models) {
    const parsed = parseCursorModelId(model.id);
    const id = parsed?.baseId ?? model.id;
    const group = groups.get(id) ?? { parameterised: [] };
    if (parsed === undefined) group.plain = model;
    else group.parameterised.push(model);
    groups.set(id, group);
  }

  const result: AcpModelProjection[] = [];
  for (const [id, group] of groups) {
    if (group.parameterised.length === 0) {
      const model = group.plain;
      if (model === undefined) continue;
      const projection = configProjection(
        configOptionsForModel(input, model.id),
        input.configuredDefaults,
      );
      result.push({
        ...model,
        selection: { modelId: model.id, config: projection.baseline },
        variants: variantsWithModelId(projection.variants, model.id),
      });
      continue;
    }

    const exact = [...group.parameterised].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const baseline =
      group.plain ??
      exact.find((model) => model.id === input.currentModelId) ??
      exact[0];
    if (baseline === undefined) continue;
    const projection = configProjection(
      configOptionsForModel(input, id, baseline.id),
      input.configuredDefaults,
    );
    const variants = variantsWithModelId(projection.variants, baseline.id);
    for (const model of exact) {
      const parameters = parseCursorModelId(model.id)?.parameters ?? "variant";
      const preferred = cursorVariantName(parameters);
      variants[uniqueVariantName(preferred, model.id, variants)] = {
        selection: { modelId: model.id, config: projection.baseline },
      };
    }
    result.push({
      id,
      name: group.plain?.name ?? baseline.name ?? id,
      selection: { modelId: baseline.id, config: projection.baseline },
      variants,
    });
  }
  return result;
}

function configOptionsForModel(
  input: {
    currentModelId?: string;
    configOptions: unknown[];
    modelConfigOptions?: Readonly<Record<string, unknown[]>>;
  },
  modelId: string,
  fallbackModelId?: string,
): unknown[] {
  const specific =
    input.modelConfigOptions?.[modelId] ??
    (fallbackModelId === undefined
      ? undefined
      : input.modelConfigOptions?.[fallbackModelId]);
  if (specific !== undefined) return specific;
  if (
    Object.keys(input.modelConfigOptions ?? {}).length === 0 ||
    modelId === input.currentModelId ||
    fallbackModelId === input.currentModelId
  ) {
    return input.configOptions;
  }
  return [];
}

function configProjection(
  options: unknown[],
  configuredDefaults: Record<string, AcpConfigValue> | undefined,
): {
  baseline: Record<string, AcpConfigValue>;
  variants: Record<string, AcpModelVariantProjection>;
} {
  const axes = configAxes(options);
  const baseline = {
    ...Object.fromEntries(axes.map((axis) => [axis.id, axis.currentValue])),
    ...(configuredDefaults ?? {}),
  };
  return {
    baseline,
    variants: generateConfigVariants(axes, baseline),
  };
}

function variantsWithModelId(
  variants: Record<string, AcpModelVariantProjection>,
  modelId: string,
): Record<string, AcpModelVariantProjection> {
  return Object.fromEntries(
    Object.entries(variants).map(([id, variant]) => [
      id,
      {
        selection: {
          modelId,
          config: variant.selection.config,
        },
      },
    ]),
  );
}

function configAxes(configOptions: unknown[]): ConfigAxis[] {
  const result: ConfigAxis[] = [];
  for (const value of configOptions) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    const id = value.id;
    const category = typeof value.category === "string" ? value.category : "";
    if (!isVariantConfigOption(id, category)) continue;
    const name = typeof value.name === "string" ? value.name : id;
    const primary =
      category === "thought_level" || /thought|reason|effort/iu.test(id);
    if (value.type === "boolean" && typeof value.currentValue === "boolean") {
      result.push({
        id,
        name,
        currentValue: value.currentValue,
        choices: [
          { value: false, name: "Off" },
          { value: true, name: "On" },
        ],
        primary,
      });
      continue;
    }
    if (value.type !== "select" || typeof value.currentValue !== "string")
      continue;
    const choices = selectChoices(value.options);
    if (choices.length === 0) continue;
    result.push({
      id,
      name,
      currentValue: value.currentValue,
      choices,
      primary,
    });
  }
  return result.sort((left, right) => {
    if (left.primary !== right.primary) return left.primary ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

function isVariantConfigOption(id: string, category: string): boolean {
  if (
    category === "model" ||
    category === "mode" ||
    id === "model" ||
    id === "mode"
  )
    return false;
  return (
    category === "thought_level" ||
    category === "model_config" ||
    knownVariantIds.has(id) ||
    /thought|reason|effort/iu.test(id)
  );
}

function selectChoices(value: unknown): ConfigChoice[] {
  if (!Array.isArray(value)) return [];
  const flattened: unknown[] = [];
  for (const item of value) {
    if (isRecord(item) && Array.isArray(item.options)) {
      for (const option of item.options) flattened.push(option as unknown);
    } else flattened.push(item);
  }
  return flattened.flatMap((item) => {
    if (!isRecord(item) || typeof item.value !== "string") return [];
    return [
      {
        value: item.value,
        name: typeof item.name === "string" ? item.name : item.value,
      },
    ];
  });
}

function generateConfigVariants(
  axes: ConfigAxis[],
  baselineConfig: Record<string, AcpConfigValue>,
): Record<string, AcpModelVariantProjection> {
  if (axes.length === 0) return {};
  const combinations: Record<string, AcpConfigValue>[] = [{}];
  for (const axis of axes) {
    const expanded: Record<string, AcpConfigValue>[] = [];
    for (const combination of combinations) {
      for (const choice of axis.choices) {
        expanded.push({ ...combination, [axis.id]: choice.value });
        if (expanded.length >= MAX_GENERATED_VARIANTS + 1) break;
      }
      if (expanded.length >= MAX_GENERATED_VARIANTS + 1) break;
    }
    combinations.splice(0, combinations.length, ...expanded);
    if (combinations.length >= MAX_GENERATED_VARIANTS + 1) break;
  }

  const variants: Record<string, AcpModelVariantProjection> = {};
  for (const combination of combinations) {
    const preferred = axes
      .map((axis) => variantSegment(axis, combination[axis.id]))
      .filter((segment) => segment.length > 0)
      .join("-");
    const config = { ...baselineConfig, ...combination };
    const identity = JSON.stringify(config);
    variants[uniqueVariantName(preferred || "custom", identity, variants)] = {
      selection: { config },
    };
    if (Object.keys(variants).length >= MAX_GENERATED_VARIANTS) break;
  }
  return variants;
}

function variantSegment(
  axis: ConfigAxis,
  value: AcpConfigValue | undefined,
): string {
  const choice = axis.choices.find((candidate) => candidate.value === value);
  const valueSlug = slug(choice?.name ?? String(value));
  if (axis.primary) return valueSlug;
  if (typeof value === "boolean") return value ? slug(axis.name) : "";
  if (/^(?:false|off|disabled|default)$/iu.test(String(value))) return "";
  if (
    /^fast(?:-mode)?$/iu.test(axis.id) &&
    /^(?:on|true|enabled|fast)$/iu.test(String(value))
  )
    return "fast";
  return `${slug(axis.name)}-${valueSlug}`;
}

function parseCursorModelId(
  id: string,
): { baseId: string; parameters: string } | undefined {
  const match = CURSOR_PARAMETERISED_MODEL.exec(id);
  const baseId = match?.[1]?.trim();
  const parameters = match?.[2]?.trim();
  if (
    baseId === undefined ||
    baseId === "" ||
    parameters === undefined ||
    parameters === ""
  )
    return undefined;
  return { baseId, parameters };
}

function cursorVariantName(parameters: string): string {
  const segments: string[] = [];
  for (const entry of parameters.split(",")) {
    const [rawKey, ...rawValue] = entry.split("=");
    const key = rawKey?.trim() ?? "";
    const value = rawValue.join("=").trim();
    if (key === "" || value === "") continue;
    if (/effort|reason|thought|thinking/iu.test(key)) {
      segments.unshift(slug(value));
      continue;
    }
    if (/^fast$/iu.test(key) && /^(?:true|on|enabled)$/iu.test(value)) {
      segments.push("fast");
      continue;
    }
    if (/^(?:false|off|disabled|default)$/iu.test(value)) continue;
    segments.push(`${slug(key)}-${slug(value)}`);
  }
  return segments.filter(Boolean).join("-") || slug(parameters);
}

function uniqueVariantName(
  preferred: string,
  identity: string,
  variants: Readonly<Record<string, unknown>>,
): string {
  const base = preferred || "variant";
  if (variants[base] === undefined) return base;
  const suffix = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 6);
  return `${base}-${suffix}`;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
