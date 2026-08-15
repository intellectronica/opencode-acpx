import { describe, expect, it, vi } from "vitest";

import { KeyedQueue } from "../../src/session/keyed-queue.js";
import { createDeferred } from "../helpers/deferred.js";

describe("KeyedQueue", () => {
  it("runs operations for one key in FIFO order", async () => {
    const queue = new KeyedQueue();
    const firstGate = createDeferred<undefined>();
    const order: string[] = [];
    const first = queue.run("session", async () => {
      order.push("first:start");
      await firstGate.promise;
      order.push("first:end");
      return 1;
    });
    const second = queue.run("session", () => {
      order.push("second");
      return Promise.resolve(2);
    });

    expect(queue.pending("session")).toBe(2);
    expect(order).toEqual(["first:start"]);
    firstGate.resolve(undefined);

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(queue.pending("session")).toBe(0);
  });

  it("allows different keys to make progress concurrently", async () => {
    const queue = new KeyedQueue();
    const leftGate = createDeferred<undefined>();
    const rightGate = createDeferred<undefined>();
    const entered: string[] = [];
    const left = queue.run("left", async () => {
      entered.push("left");
      await leftGate.promise;
      return "left-result";
    });
    const right = queue.run("right", async () => {
      entered.push("right");
      await rightGate.promise;
      return "right-result";
    });

    expect(entered).toEqual(["left", "right"]);
    expect(queue.pending("left")).toBe(1);
    expect(queue.pending("right")).toBe(1);
    rightGate.resolve(undefined);
    await expect(right).resolves.toBe("right-result");
    expect(queue.pending("left")).toBe(1);
    leftGate.resolve(undefined);
    await expect(left).resolves.toBe("left-result");
  });

  it("continues draining after an operation fails", async () => {
    const queue = new KeyedQueue();
    const failure = new Error("operation failed");
    const first = queue.run("session", () => Promise.reject(failure));
    const secondOperation = vi.fn(() => Promise.resolve("recovered"));
    const second = queue.run("session", secondOperation);

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe("recovered");
    expect(secondOperation).toHaveBeenCalledOnce();
    expect(queue.pending("session")).toBe(0);
  });

  it("rejects without enqueueing when the signal is already aborted", async () => {
    const queue = new KeyedQueue();
    const controller = new AbortController();
    const reason = new Error("cancelled before enqueue");
    const operation = vi.fn(() => Promise.resolve("unexpected"));
    controller.abort(reason);

    await expect(
      queue.run("session", operation, controller.signal),
    ).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
    expect(queue.pending("session")).toBe(0);
  });

  it("skips a queued operation if it is aborted before becoming active", async () => {
    const queue = new KeyedQueue();
    const gate = createDeferred<undefined>();
    const controller = new AbortController();
    const reason = new Error("cancelled in queue");
    const first = queue.run("session", async () => {
      await gate.promise;
    });
    const operation = vi.fn(() => Promise.resolve("unexpected"));
    const second = queue.run("session", operation, controller.signal);

    controller.abort(reason);
    gate.resolve(undefined);

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
    expect(queue.pending("session")).toBe(0);
  });

  it("does not treat aborting an active operation as cooperative cancellation", async () => {
    const queue = new KeyedQueue();
    const gate = createDeferred<string>();
    const controller = new AbortController();
    const operation = queue.run(
      "session",
      async () => gate.promise,
      controller.signal,
    );

    controller.abort(new Error("active abort"));
    gate.resolve("completed by operation");

    await expect(operation).resolves.toBe("completed by operation");
  });
});
