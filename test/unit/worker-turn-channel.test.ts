import { describe, expect, it } from "vitest";

import { TurnChannel } from "../../src/worker/turn-channel.js";

describe("TurnChannel", () => {
  it("replays an ordered turn and stops at its terminal result", async () => {
    const channel = new TurnChannel("turn-1");
    channel.push({
      type: "turn.event",
      turnId: "turn-1",
      index: 0,
      event: { type: "text_delta", text: "hello" },
    });
    channel.push({
      type: "turn.result",
      turnId: "turn-1",
      index: 1,
      result: { status: "completed" },
    });

    const events = [];
    for await (const event of channel.events()) events.push(event);
    expect(events).toHaveLength(2);
    expect(channel.terminal?.result.status).toBe("completed");
  });

  it("rejects mismatched, out-of-order, and post-terminal events", () => {
    const channel = new TurnChannel("turn-1");
    expect(() =>
      channel.push({
        type: "turn.event",
        turnId: "turn-2",
        index: 0,
        event: { type: "text_delta", text: "wrong" },
      }),
    ).toThrow(/does not belong/u);
    expect(() =>
      channel.push({
        type: "turn.event",
        turnId: "turn-1",
        index: 1,
        event: { type: "text_delta", text: "late" },
      }),
    ).toThrow(/expected event index 0/u);
    channel.push({
      type: "turn.result",
      turnId: "turn-1",
      index: 0,
      result: { status: "completed" },
    });
    expect(() =>
      channel.push({
        type: "turn.event",
        turnId: "turn-1",
        index: 1,
        event: { type: "text_delta", text: "after" },
      }),
    ).toThrow(/terminal/u);
  });

  it("rejects invalid replay cursors and propagates failures", async () => {
    const channel = new TurnChannel("turn-1");
    const invalid = channel.events(1);
    await expect(invalid.next()).rejects.toThrow(RangeError);

    const failed = channel.events();
    channel.fail(new Error("worker stopped"));
    await expect(failed.next()).rejects.toThrow("worker stopped");
  });
});
