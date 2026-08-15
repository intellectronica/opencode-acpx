import { delimiter, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  resolveNodeCommand,
  resolveWorkerNodeRuntime,
} from "../../src/worker/client.js";

describe("worker client", () => {
  it("captures the first executable Node path instead of retaining a bare command", () => {
    const first = join("", "missing", "bin");
    const second = join("", "available", "bin");
    const executable = vi.fn((path: string) => path.startsWith(second));

    const resolved = resolveNodeCommand(
      [first, second].join(delimiter),
      executable,
    );

    expect(resolved).toBe(join(second, "node"));
    expect(executable).toHaveBeenCalledWith(join(first, "node"));
    expect(executable).toHaveBeenCalledWith(join(second, "node"));
  });

  it("retains the portable command fallback when Node cannot be resolved", () => {
    expect(resolveNodeCommand("", () => false)).toBe("node");
  });

  it("uses a standard absolute Node location when PATH is unavailable", () => {
    expect(
      resolveNodeCommand("", (path) => path === "/opt/homebrew/bin/node"),
    ).toBe("/opt/homebrew/bin/node");
  });

  it("uses the Electron host as Node without depending on PATH", () => {
    const executable = vi.fn(() => true);

    expect(
      resolveWorkerNodeRuntime(
        "42.3.3",
        "/Applications/OpenCode Helper",
        "",
        executable,
      ),
    ).toEqual({
      command: "/Applications/OpenCode Helper",
      electronRunAsNode: true,
    });
  });

  it("recognises an isolated OpenCode Helper context without Electron version metadata", () => {
    expect(
      resolveWorkerNodeRuntime(
        undefined,
        "/Applications/OpenCode.app/Contents/Frameworks/OpenCode Helper.app/Contents/MacOS/OpenCode Helper",
        "",
        () => true,
      ),
    ).toMatchObject({ electronRunAsNode: true });
  });
});
