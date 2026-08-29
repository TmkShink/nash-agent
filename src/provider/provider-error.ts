export type ProviderErrorKind =
  | "cancelled"
  | "timeout"
  | "network"
  | "http"
  | "protocol"
  | "request";

export class ProviderError extends Error {
  public readonly kind: ProviderErrorKind;
  public readonly retryable: boolean;
  public readonly statusCode: number | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(options: {
    readonly kind: ProviderErrorKind;
    readonly message: string;
    readonly retryable: boolean;
    readonly statusCode?: number;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
  }
}
