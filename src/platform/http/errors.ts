/**
 * Catálogo de erros da API.
 *
 * Os códigos são estáveis e fazem parte do contrato público: o app Android
 * decide o que fazer com base neles, nunca na mensagem. Mensagens podem ser
 * reescritas livremente; códigos, não.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_JSON: 'MALFORMED_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_SESSION_REVOKED: 'AUTH_SESSION_REVOKED',
  AUTH_PERMISSION_STALE: 'AUTH_PERMISSION_STALE',
  AUTH_ACCOUNT_LOCKED: 'AUTH_ACCOUNT_LOCKED',
  AUTH_ACCOUNT_SUSPENDED: 'AUTH_ACCOUNT_SUSPENDED',
  AUTH_EMAIL_IN_USE: 'AUTH_EMAIL_IN_USE',
  AUTH_EMAIL_NOT_VERIFIED: 'AUTH_EMAIL_NOT_VERIFIED',
  AUTH_TOKEN_REUSE_DETECTED: 'AUTH_TOKEN_REUSE_DETECTED',
  AUTH_WEAK_PASSWORD: 'AUTH_WEAK_PASSWORD',

  FORBIDDEN: 'FORBIDDEN',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  MEMBER_SUSPENDED: 'MEMBER_SUSPENDED',
  MISSING_PERMISSION: 'MISSING_PERMISSION',
  LAST_OWNER: 'LAST_OWNER',
  INVITE_INVALID: 'INVITE_INVALID',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  INVITE_ALREADY_USED: 'INVITE_ALREADY_USED',
  ALREADY_MEMBER: 'ALREADY_MEMBER',

  SUBSCRIPTION_REQUIRED: 'SUBSCRIPTION_REQUIRED',
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',
  PURCHASE_TOKEN_IN_USE: 'PURCHASE_TOKEN_IN_USE',
  PURCHASE_TOKEN_INVALID: 'PURCHASE_TOKEN_INVALID',
  BILLING_UNAVAILABLE: 'BILLING_UNAVAILABLE',

  SYNC_DISABLED: 'SYNC_DISABLED',
  SYNC_PROTOCOL_UNSUPPORTED: 'SYNC_PROTOCOL_UNSUPPORTED',
  SYNC_RESYNC_REQUIRED: 'SYNC_RESYNC_REQUIRED',
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_ALREADY_SEEDED: 'SYNC_ALREADY_SEEDED',
  SYNC_UPLOAD_NOT_FOUND: 'SYNC_UPLOAD_NOT_FOUND',
  SYNC_UPLOAD_ALREADY_COMPLETED: 'SYNC_UPLOAD_ALREADY_COMPLETED',
  SYNC_UPLOAD_COUNT_MISMATCH: 'SYNC_UPLOAD_COUNT_MISMATCH',
  SYNC_BATCH_TOO_LARGE: 'SYNC_BATCH_TOO_LARGE',

  CONFLICT: 'CONFLICT',
  STALE_REVISION: 'STALE_REVISION',
  DUPLICATE_NAME: 'DUPLICATE_NAME',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorDetail {
  field?: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details: ErrorDetail[] | undefined;
  /** Campos extras específicos do erro, incluídos na resposta (ex.: cursor de resync). */
  readonly extra: Record<string, unknown> | undefined;
  /** Marcado como false em falhas realmente inesperadas, que devem alertar. */
  readonly expected: boolean;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    options: {
      details?: ErrorDetail[];
      extra?: Record<string, unknown>;
      cause?: unknown;
      expected?: boolean;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.extra = options.extra;
    this.expected = options.expected ?? true;
  }
}

export const badRequest = (code: ErrorCodeValue, message: string, details?: ErrorDetail[]) =>
  new AppError(400, code, message, details ? { details } : {});

export const unauthorized = (code: ErrorCodeValue, message: string) =>
  new AppError(401, code, message);

export const forbidden = (code: ErrorCodeValue, message: string, extra?: Record<string, unknown>) =>
  new AppError(403, code, message, extra ? { extra } : {});

export const notFound = (message = 'Recurso não encontrado') =>
  new AppError(404, ErrorCode.NOT_FOUND, message);

export const conflict = (code: ErrorCodeValue, message: string, extra?: Record<string, unknown>) =>
  new AppError(409, code, message, extra ? { extra } : {});

export const tooManyRequests = (message: string, retryAfterSeconds?: number) =>
  new AppError(429, ErrorCode.RATE_LIMITED, message, {
    extra: retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined,
  });

export const upgradeRequired = (message: string, extra?: Record<string, unknown>) =>
  new AppError(426, ErrorCode.SYNC_PROTOCOL_UNSUPPORTED, message, extra ? { extra } : {});
