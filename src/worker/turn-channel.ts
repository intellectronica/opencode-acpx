import type {
  PermissionInteraction,
  RuntimeWorkerEvent,
  WorkerTurnEvent,
  WorkerTurnResult,
} from "./messages.js";

type SequencedTurnEvent =
  | WorkerTurnEvent
  | WorkerTurnResult
  | PermissionInteraction;

const MAX_BUFFERED_TURN_EVENTS = 100_000;

interface Waiter {
  cursor: number;
  resolve: () => void;
}

export class TurnChannel {
  readonly #events: RuntimeWorkerEvent[] = [];
  readonly #waiters = new Set<Waiter>();
  #terminal?: WorkerTurnResult;
  #failure?: Error;

  constructor(readonly turnId: string) {}

  push(event: SequencedTurnEvent): void {
    if (event.turnId !== this.turnId) {
      throw new Error(`Event does not belong to turn ${this.turnId}`);
    }
    if (this.#terminal !== undefined) {
      throw new Error(
        `Turn ${this.turnId} received an event after its terminal result`,
      );
    }
    if (event.index !== this.#events.length) {
      throw new Error(
        `Turn ${this.turnId} expected event index ${String(this.#events.length)}, received ${String(event.index)}`,
      );
    }
    if (this.#events.length >= MAX_BUFFERED_TURN_EVENTS) {
      throw new Error(`Turn ${this.turnId} exceeded its event buffer limit`);
    }
    this.#events.push(event);
    if (event.type === "turn.result") this.#terminal = event;
    this.#wake();
  }

  fail(error: Error): void {
    this.#failure ??= error;
    this.#wake();
  }

  get length(): number {
    return this.#events.length;
  }

  get terminal(): WorkerTurnResult | undefined {
    return this.#terminal;
  }

  async *events(
    cursor = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeWorkerEvent> {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > this.#events.length
    ) {
      throw new RangeError(
        `Invalid event cursor ${String(cursor)} for turn ${this.turnId}`,
      );
    }
    let index = cursor;
    for (;;) {
      if (signal?.aborted === true) throw abortError(signal);
      if (this.#failure !== undefined) throw this.#failure;
      const event = this.#events[index];
      if (event !== undefined) {
        index += 1;
        yield event;
        if (event.type === "turn.result") return;
        continue;
      }
      if (this.#terminal !== undefined) return;
      await this.#wait(index, signal);
    }
  }

  async #wait(cursor: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const waiter = { cursor, resolve };
      const onAbort = (): void => {
        this.#waiters.delete(waiter);
        reject(
          signal === undefined
            ? new Error("Turn wait aborted")
            : abortError(signal),
        );
      };
      this.#waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      const originalResolve = waiter.resolve;
      waiter.resolve = () => {
        signal?.removeEventListener("abort", onAbort);
        originalResolve();
      };
    });
  }

  #wake(): void {
    for (const waiter of this.#waiters) {
      if (
        this.#events.length > waiter.cursor ||
        this.#terminal !== undefined ||
        this.#failure !== undefined
      ) {
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(
        signal.reason === undefined
          ? "Operation aborted"
          : String(signal.reason),
      );
}
