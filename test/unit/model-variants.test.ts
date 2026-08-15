import { describe, expect, it } from "vitest";

import {
  projectAcpModels,
  providerSelectionOptions,
} from "../../src/model-variants.js";

describe("ACP model variant projection", () => {
  it("groups Cursor parameterised model IDs and retains every exact wire ID", () => {
    const models = projectAcpModels({
      preset: "cursor",
      models: [
        { id: "grok-4.6[effort=low,fast=false]", name: "Grok 4.6 Low" },
        { id: "grok-4.6[effort=high,fast=true]", name: "Grok 4.6 High" },
        { id: "composer", name: "Composer" },
      ],
      currentModelId: "grok-4.6[effort=low,fast=false]",
      configOptions: [],
    });

    const grok = models.find((model) => model.id === "grok-4.6");
    expect(grok?.selection.modelId).toBe("grok-4.6[effort=low,fast=false]");
    expect(Object.values(grok?.variants ?? {})).toEqual(
      expect.arrayContaining([
        {
          selection: {
            modelId: "grok-4.6[effort=low,fast=false]",
            config: {},
          },
        },
        {
          selection: {
            modelId: "grok-4.6[effort=high,fast=true]",
            config: {},
          },
        },
      ]),
    );
    expect(models.find((model) => model.id === "composer")).toMatchObject({
      selection: { modelId: "composer" },
    });
  });

  it("creates deterministic effort and Boolean fast combinations with an explicit baseline", () => {
    const [model] = projectAcpModels({
      preset: "codex",
      models: [{ id: "gpt-5.6-sol" }],
      configOptions: [
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
        {
          id: "fast-mode",
          name: "Fast",
          category: "model_config",
          type: "boolean",
          currentValue: false,
        },
        {
          id: "mode",
          category: "mode",
          type: "select",
          currentValue: "agent",
          options: [{ value: "agent", name: "Agent" }],
        },
      ],
    });

    expect(model?.selection).toEqual({
      modelId: "gpt-5.6-sol",
      config: { reasoning_effort: "medium", "fast-mode": false },
    });
    expect(model?.variants).toHaveProperty("medium");
    expect(Object.values(model?.variants ?? {})).toEqual(
      expect.arrayContaining([
        {
          selection: {
            modelId: "gpt-5.6-sol",
            config: { reasoning_effort: "high", "fast-mode": false },
          },
        },
        {
          selection: {
            modelId: "gpt-5.6-sol",
            config: { reasoning_effort: "medium", "fast-mode": true },
          },
        },
      ]),
    );
    expect(JSON.stringify(model?.variants)).not.toContain('"mode"');
  });

  it("flattens grouped select leaves and keeps Boolean false in provider options", () => {
    const [model] = projectAcpModels({
      preset: "claude",
      models: [{ id: "claude-opus-5" }],
      configOptions: [
        {
          id: "effort",
          category: "thought_level",
          type: "select",
          currentValue: "default",
          options: [
            {
              group: "Reasoning",
              name: "Reasoning",
              options: [
                { value: "default", name: "Default" },
                { value: "max", name: "Max" },
              ],
            },
          ],
        },
        {
          id: "fast",
          category: "model_config",
          type: "boolean",
          currentValue: false,
        },
      ],
    });
    const maximum = Object.values(model?.variants ?? {}).find(
      (variant) => variant.selection.config.effort === "max",
    );
    expect(maximum?.selection.config.fast).toBe(false);
    expect(
      providerSelectionOptions({
        modelId: "claude-opus-5",
        config: { effort: "max", fast: false },
      }),
    ).toEqual({
      opencodeAcpx: {
        modelId: "claude-opus-5",
        config: { effort: "max", fast: false },
      },
    });
  });

  it("scopes conditional effort controls to the model that advertised them", () => {
    const models = projectAcpModels({
      preset: "codex",
      models: [{ id: "gpt-with-effort" }, { id: "gpt-without-effort" }],
      configOptions: [],
      modelConfigOptions: {
        "gpt-with-effort": [
          {
            id: "reasoning_effort",
            category: "thought_level",
            type: "select",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
        ],
        "gpt-without-effort": [],
      },
    });

    expect(models[0]?.variants).toHaveProperty("low");
    expect(models[0]?.variants).toHaveProperty("high");
    expect(models[1]?.variants).toEqual({});
  });
});
