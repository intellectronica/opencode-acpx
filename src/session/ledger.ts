import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

const turnReceiptSchema = z
  .object({
    status: z.enum(["in-flight", "completed", "cancelled", "failed"]),
    updatedAt: z.string(),
    cursor: z.number().int().nonnegative().default(0),
    replay: z.array(z.unknown()).default([]),
    unsafeToRetry: z.boolean().default(false),
    error: z.string().optional(),
  })
  .strict();

export type TurnReceipt = z.infer<typeof turnReceiptSchema>;

const bindingSchema = z
  .object({
    sessionKey: z.string().min(1),
    serverId: z.string().min(1),
    openCodeSessionId: z.string().min(1),
    worktree: z.string().min(1),
    generation: z.number().int().nonnegative(),
    selectedModel: z.string().optional(),
    selectedConfig: z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .default({}),
    lastCompletedMessageId: z.string().optional(),
    transcriptPrefixDigest: z.string().optional(),
    turns: z.record(z.string(), turnReceiptSchema).default({}),
    updatedAt: z.string(),
  })
  .strict();

export type BindingRecord = z.infer<typeof bindingSchema>;

const ledgerSchema = z
  .object({
    schema: z.literal(1),
    bindings: z.record(z.string(), bindingSchema).default({}),
  })
  .strict();

type LedgerDocument = z.infer<typeof ledgerSchema>;

export type BeginTurnResult =
  | { kind: "start" }
  | { kind: "join"; receipt: TurnReceipt }
  | { kind: "replay"; receipt: TurnReceipt }
  | { kind: "unsafe"; receipt: TurnReceipt };

export interface BindingLedgerOptions {
  path: string;
  staleLockMs?: number;
  lockTimeoutMs?: number;
}

/**
 * Durable OpenCode-to-ACP binding and idempotency ledger.
 *
 * The file lease protects multiple OpenCode processes using the same state
 * directory. It is deliberately short-lived: no ACP prompt is executed while
 * the lease is held.
 */
export class BindingLedger {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #staleLockMs: number;
  readonly #lockTimeoutMs: number;

  constructor(options: BindingLedgerOptions) {
    this.#path = options.path;
    this.#lockPath = `${options.path}.lock`;
    this.#staleLockMs = options.staleLockMs ?? 30_000;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  async get(bindingId: string): Promise<BindingRecord | undefined> {
    const document = await this.#read();
    return document.bindings[bindingId];
  }

  async put(bindingId: string, binding: BindingRecord): Promise<void> {
    await this.#mutate((document) => {
      document.bindings[bindingId] = bindingSchema.parse(binding);
    });
  }

  async beginTurn(
    bindingId: string,
    messageId: string,
  ): Promise<BeginTurnResult> {
    let result: BeginTurnResult = { kind: "start" };
    await this.#mutate((document) => {
      const binding = document.bindings[bindingId];
      if (binding === undefined)
        throw new Error(`Unknown ACP binding: ${bindingId}`);
      const existing = binding.turns[messageId];
      if (existing?.status === "completed") {
        result = { kind: "replay", receipt: existing };
        return;
      }
      if (existing?.status === "in-flight") {
        result = { kind: "join", receipt: existing };
        return;
      }
      if (existing?.unsafeToRetry === true) {
        result = { kind: "unsafe", receipt: existing };
        return;
      }
      binding.turns[messageId] = {
        status: "in-flight",
        updatedAt: new Date().toISOString(),
        cursor: 0,
        replay: [],
        unsafeToRetry: false,
      };
      binding.updatedAt = new Date().toISOString();
    });
    return result;
  }

  async record(
    bindingId: string,
    messageId: string,
    input: {
      cursor: number;
      replay?: unknown[];
      unsafeToRetry?: boolean;
    },
  ): Promise<void> {
    await this.#mutate((document) => {
      const binding = document.bindings[bindingId];
      const receipt = binding?.turns[messageId];
      if (binding === undefined || receipt === undefined)
        throw new Error("Unknown ACP turn receipt");
      receipt.cursor = Math.max(receipt.cursor, input.cursor);
      if (input.replay !== undefined) receipt.replay.push(...input.replay);
      if (input.unsafeToRetry === true) receipt.unsafeToRetry = true;
      receipt.updatedAt = new Date().toISOString();
      binding.updatedAt = receipt.updatedAt;
    });
  }

  async finishTurn(
    bindingId: string,
    messageId: string,
    status: Exclude<TurnReceipt["status"], "in-flight">,
    error?: string,
  ): Promise<void> {
    await this.#mutate((document) => {
      const binding = document.bindings[bindingId];
      const receipt = binding?.turns[messageId];
      if (binding === undefined || receipt === undefined)
        throw new Error("Unknown ACP turn receipt");
      receipt.status = status;
      receipt.updatedAt = new Date().toISOString();
      if (error === undefined) delete receipt.error;
      else receipt.error = error;
      if (status === "completed") binding.lastCompletedMessageId = messageId;
      binding.updatedAt = receipt.updatedAt;
    });
  }

  async remove(bindingId: string): Promise<void> {
    await this.#mutate((document) => {
      if (!Reflect.deleteProperty(document.bindings, bindingId)) {
        throw new Error(`Unable to remove ACP binding: ${bindingId}`);
      }
    });
  }

  async #mutate(change: (document: LedgerDocument) => void): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const release = await this.#acquireLease();
    try {
      const document = await this.#read();
      change(document);
      await this.#write(document);
    } finally {
      await release();
    }
  }

  async #read(): Promise<LedgerDocument> {
    try {
      const source = await readFile(this.#path, "utf8");
      return ledgerSchema.parse(JSON.parse(source));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { schema: 1, bindings: {} };
      }
      throw error;
    }
  }

  async #write(document: LedgerDocument): Promise<void> {
    const validated = ledgerSchema.parse(document);
    const temporary = `${this.#path}.${String(process.pid)}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.#path);
  }

  async #acquireLease(): Promise<() => Promise<void>> {
    const startedAt = Date.now();
    for (;;) {
      try {
        const handle = await open(this.#lockPath, "wx", 0o600);
        await handle.writeFile(`${String(process.pid)}\n`, "utf8");
        return async () => {
          await handle.close();
          await unlink(this.#lockPath).catch((error: unknown) => {
            if (
              !(
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
              )
            ) {
              throw error;
            }
          });
        };
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          )
        ) {
          throw error;
        }
        const lock = await stat(this.#lockPath).catch(() => undefined);
        if (
          lock !== undefined &&
          Date.now() - lock.mtimeMs > this.#staleLockMs
        ) {
          await unlink(this.#lockPath).catch((unlinkError: unknown) => {
            if (!isErrorCode(unlinkError, "ENOENT")) throw unlinkError;
          });
          continue;
        }
        if (Date.now() - startedAt >= this.#lockTimeoutMs) {
          throw new Error(
            `Timed out acquiring ACP binding lease: ${this.#lockPath}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function createBindingRecord(input: {
  sessionKey: string;
  serverId: string;
  openCodeSessionId: string;
  worktree: string;
  generation?: number;
}): BindingRecord {
  return bindingSchema.parse({
    ...input,
    generation: input.generation ?? 0,
    selectedConfig: {},
    turns: {},
    updatedAt: new Date().toISOString(),
  });
}
