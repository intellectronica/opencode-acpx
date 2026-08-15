import { describe, expect, it, vi } from "vitest";

import tuiModule from "../../src/tui.js";

describe("TUI plugin", () => {
  it("registers a conservative status command", async () => {
    let commands: { run?: () => void }[] = [];
    const toast = vi.fn();
    const api = {
      keymap: {
        registerLayer: vi.fn((layer: { commands: typeof commands }) => {
          commands = layer.commands;
          return vi.fn();
        }),
      },
      state: {
        provider: [
          { id: "anthropic", name: "Anthropic", models: {} },
          {
            id: "acp.cursor",
            name: "Cursor Agent",
            models: { default: {}, composer: {} },
          },
        ],
      },
      ui: { toast },
    };

    await tuiModule.tui(api as never);
    commands[0]?.run?.();

    expect(toast).toHaveBeenCalledWith({
      variant: "info",
      title: "ACP providers",
      message: "Cursor Agent: 2 model(s)",
    });
  });
});
