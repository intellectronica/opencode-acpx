interface QueueTask<T> {
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
}

interface QueueState {
  active: boolean;
  tasks: QueueTask<unknown>[];
}

function rejectionReason(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("Queued operation aborted");
}

export class KeyedQueue {
  readonly #queues = new Map<string, QueueState>();

  run<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted === true)
      return Promise.reject(rejectionReason(signal.reason));
    return new Promise<T>((resolve, reject) => {
      const state = this.#queues.get(key) ?? { active: false, tasks: [] };
      this.#queues.set(key, state);
      state.tasks.push({
        operation,
        resolve,
        reject,
        signal,
      } as QueueTask<unknown>);
      void this.#drain(key, state);
    });
  }

  pending(key: string): number {
    const state = this.#queues.get(key);
    return state === undefined ? 0 : state.tasks.length + Number(state.active);
  }

  async #drain(key: string, state: QueueState): Promise<void> {
    if (state.active) return;
    state.active = true;
    try {
      for (;;) {
        const task = state.tasks.shift();
        if (task === undefined) break;
        if (task.signal?.aborted === true) {
          task.reject(rejectionReason(task.signal.reason));
          continue;
        }
        try {
          task.resolve(await task.operation());
        } catch (error) {
          task.reject(error);
        }
      }
    } finally {
      state.active = false;
      if (state.tasks.length === 0) this.#queues.delete(key);
      else void this.#drain(key, state);
    }
  }
}
