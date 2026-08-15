export type AcpCompatErrorCode =
  | "ACP_COMPAT_UNSUPPORTED"
  | "ACP_COMPAT_INVALID_PARAMS"
  | "ACP_COMPAT_ABORTED"
  | "ACP_COMPAT_HANDLER_FAILED";

const JSON_RPC_ERROR_CODES: Record<AcpCompatErrorCode, number> = {
  ACP_COMPAT_UNSUPPORTED: -32601,
  ACP_COMPAT_INVALID_PARAMS: -32602,
  ACP_COMPAT_ABORTED: -32800,
  ACP_COMPAT_HANDLER_FAILED: -32603,
};

export class AcpCompatError extends Error {
  readonly code: AcpCompatErrorCode;
  readonly method?: string;
  readonly interactionId?: string;
  override readonly cause?: unknown;

  constructor(
    code: AcpCompatErrorCode,
    message: string,
    options: { method?: string; interactionId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AcpCompatError";
    this.code = code;
    if (options.method !== undefined) this.method = options.method;
    if (options.interactionId !== undefined)
      this.interactionId = options.interactionId;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJsonRpcError(): {
    code: number;
    message: string;
    data: Record<string, unknown>;
  } {
    return {
      code: JSON_RPC_ERROR_CODES[this.code],
      message: this.message,
      data: {
        compatibilityCode: this.code,
        ...(this.method === undefined ? {} : { method: this.method }),
        ...(this.interactionId === undefined
          ? {}
          : { interactionId: this.interactionId }),
      },
    };
  }
}

export function isAcpCompatError(value: unknown): value is AcpCompatError {
  return value instanceof AcpCompatError;
}
