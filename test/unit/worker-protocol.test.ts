import { describe, expect, it } from "vitest";

import { RPC_PROTOCOL_VERSION } from "../../src/constants.js";
import {
  BoundedNdjsonDecoder,
  encodeBoundedFrame,
  errorResponse,
  eventEnvelopeSchema,
  parseMethodParams,
  parseMethodResult,
  parseRuntimeWorkerEvent,
  requestEnvelopeSchema,
  responseEnvelopeSchema,
  successResponse,
  workerEvent,
} from "../../src/worker/protocol.js";

const TOKEN = "a".repeat(64);

describe("requestEnvelopeSchema", () => {
  const request = {
    kind: "request",
    version: RPC_PROTOCOL_VERSION,
    token: TOKEN,
    id: "request-1",
    method: "session.ensure",
    params: { session: "one" },
  } as const;

  it("accepts a complete versioned request", () => {
    expect(requestEnvelopeSchema.parse(request)).toEqual(request);
  });

  it.each([
    ["wrong kind", { kind: "event" }],
    ["wrong version", { version: RPC_PROTOCOL_VERSION + 1 }],
    ["short token", { token: "short" }],
    ["empty identifier", { id: "" }],
    ["long identifier", { id: "x".repeat(513) }],
    ["empty method", { method: "" }],
  ])("rejects a request with %s", (_label, override) => {
    expect(
      requestEnvelopeSchema.safeParse({ ...request, ...override }).success,
    ).toBe(false);
  });

  it("allows an undefined opaque params payload", () => {
    expect(
      requestEnvelopeSchema.parse({ ...request, params: undefined }),
    ).toMatchObject({
      params: undefined,
    });
  });

  it("rejects unknown envelope fields", () => {
    expect(
      requestEnvelopeSchema.safeParse({ ...request, extra: true }).success,
    ).toBe(false);
  });
});

describe("responseEnvelopeSchema", () => {
  it("accepts falsey and null success results", () => {
    for (const result of [null, false, 0, ""]) {
      expect(
        responseEnvelopeSchema.safeParse(
          successResponse(TOKEN, "request-1", result),
        ).success,
      ).toBe(true);
    }
  });

  it("accepts an error with or without details", () => {
    expect(
      responseEnvelopeSchema.parse(
        errorResponse(TOKEN, "request-1", "FAILED", "Failed"),
      ),
    ).toEqual({
      kind: "response",
      version: RPC_PROTOCOL_VERSION,
      token: TOKEN,
      id: "request-1",
      error: { code: "FAILED", message: "Failed" },
    });
    expect(
      responseEnvelopeSchema.parse(
        errorResponse(TOKEN, "request-2", "FAILED", "Failed", {
          retryable: false,
        }),
      ),
    ).toMatchObject({ error: { details: { retryable: false } } });
  });

  it("requires exactly one of result and error", () => {
    const base = {
      kind: "response",
      version: RPC_PROTOCOL_VERSION,
      token: TOKEN,
      id: "request-1",
    };

    expect(responseEnvelopeSchema.safeParse(base).success).toBe(false);
    expect(
      responseEnvelopeSchema.safeParse({
        ...base,
        result: { ok: true },
        error: { code: "FAILED", message: "Failed" },
      }).success,
    ).toBe(false);
  });

  it("normalises an undefined success payload to null", () => {
    expect(
      responseEnvelopeSchema.parse(
        successResponse(TOKEN, "request-1", undefined),
      ),
    ).toMatchObject({ result: null });
  });

  it("rejects malformed errors and unknown fields", () => {
    expect(
      responseEnvelopeSchema.safeParse({
        kind: "response",
        version: RPC_PROTOCOL_VERSION,
        token: TOKEN,
        id: "request-1",
        error: { code: "FAILED" },
      }).success,
    ).toBe(false);
    expect(
      responseEnvelopeSchema.safeParse({
        ...successResponse(TOKEN, "request-1", null),
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("eventEnvelopeSchema", () => {
  it("creates and validates an event envelope", () => {
    const event = workerEvent(TOKEN, {
      type: "diagnostic",
      level: "info",
      message: "hello",
    });

    expect(eventEnvelopeSchema.parse(event)).toEqual({
      kind: "event",
      version: RPC_PROTOCOL_VERSION,
      token: TOKEN,
      event: { type: "diagnostic", level: "info", message: "hello" },
    });
  });

  it.each([
    ["short token", { token: "short" }],
    ["wrong version", { version: RPC_PROTOCOL_VERSION + 1 }],
    ["unknown field", { extra: true }],
  ])("rejects an event with %s", (_label, override) => {
    const event = workerEvent(TOKEN, {
      type: "diagnostic",
      level: "info",
      message: "hello",
    });

    expect(
      eventEnvelopeSchema.safeParse({ ...event, ...override }).success,
    ).toBe(false);
  });

  it("allows an opaque envelope but rejects an undefined runtime event", () => {
    expect(
      eventEnvelopeSchema.parse({
        kind: "event",
        version: RPC_PROTOCOL_VERSION,
        token: TOKEN,
        event: undefined,
      }),
    ).toMatchObject({
      event: undefined,
    });
    expect(() => parseRuntimeWorkerEvent(undefined)).toThrow();
  });
});

describe("method schemas", () => {
  it("uses strict per-method parameter schemas", () => {
    expect(
      parseMethodParams("session.close", {
        serverId: "cursor",
        sessionKey: "session-1",
        discardPersistentState: true,
      }),
    ).toMatchObject({ discardPersistentState: true });
    expect(() =>
      parseMethodParams("session.close", {
        serverId: "cursor",
        sessionKey: "session-1",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects malformed method results", () => {
    expect(
      parseMethodResult("turn.start", { ok: true, state: "existing" }),
    ).toEqual({
      ok: true,
      state: "existing",
    });
    expect(() => parseMethodResult("turn.start", { ok: true })).toThrow();
  });
});

describe("bounded NDJSON framing", () => {
  it("decodes fragmented and multiple frames", () => {
    const decoder = new BoundedNdjsonDecoder(16);
    expect(decoder.push('{"a"')).toEqual([]);
    expect(decoder.push(":1}\n{}\r\n")).toEqual(['{"a":1}', "{}"]);
    expect(() => decoder.end()).not.toThrow();
  });

  it("rejects oversized and incomplete frames", () => {
    expect(() => new BoundedNdjsonDecoder(4).push("12345")).toThrow(/exceeds/u);
    const decoder = new BoundedNdjsonDecoder(16);
    decoder.push("partial");
    expect(() => decoder.end()).toThrow(/Incomplete/u);
  });

  it("bounds encoded frames including the newline", () => {
    const envelope = successResponse(TOKEN, "request-1", null);
    const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8") + 1;
    expect(encodeBoundedFrame(envelope, bytes).endsWith("\n")).toBe(true);
    expect(() => encodeBoundedFrame(envelope, bytes - 1)).toThrow(/exceeds/u);
  });
});
