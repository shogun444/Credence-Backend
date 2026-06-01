import { ErrorCode } from './errors.js'

/**
 * Structured metadata for the backend error_code registry.
 * Source of truth for SDK error class generation (`scripts/generate-sdk-errors.ts`).
 */
export type ErrorCatalogKind = 'api' | 'transport'

export interface ErrorCatalogEntry {
  /** Wire value returned in API envelopes (`code` field). */
  code: string
  /** Generated SDK class name (must be unique). */
  sdkClassName: string
  /** `api` = backend JSON envelope; `transport` = client-side only. */
  kind: ErrorCatalogKind
  /** Default HTTP status when thrown as AppError (`null` for transport-only). */
  httpStatus: number | null
  /** Human-readable default message for SDK fallbacks. */
  defaultMessage: string
  /** Still generated and mapped, but marked @deprecated in SDK output. */
  deprecated?: boolean
  /** Replacement wire code when deprecated. */
  replacedBy?: string
  /** Fallback when HTTP status/body cannot be mapped to a known api code. */
  unmappedHttpFallback?: boolean
}

export const ERROR_CATALOG = {
  [ErrorCode.VALIDATION_FAILED]: {
    code: ErrorCode.VALIDATION_FAILED,
    sdkClassName: 'ValidationFailedCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'Validation failed',
  },
  [ErrorCode.FIELD_REQUIRED]: {
    code: ErrorCode.FIELD_REQUIRED,
    sdkClassName: 'FieldRequiredCredenceError',
    kind: 'api',
    httpStatus: null,
    defaultMessage: 'Required field is missing',
  },
  [ErrorCode.INVALID_FORMAT]: {
    code: ErrorCode.INVALID_FORMAT,
    sdkClassName: 'InvalidFormatCredenceError',
    kind: 'api',
    httpStatus: null,
    defaultMessage: 'Invalid format',
  },
  [ErrorCode.INVALID_ADDRESS]: {
    code: ErrorCode.INVALID_ADDRESS,
    sdkClassName: 'InvalidAddressCredenceError',
    kind: 'api',
    httpStatus: null,
    defaultMessage: 'Invalid address',
  },
  [ErrorCode.INVALID_TYPE]: {
    code: ErrorCode.INVALID_TYPE,
    sdkClassName: 'InvalidTypeCredenceError',
    kind: 'api',
    httpStatus: null,
    defaultMessage: 'Invalid type',
  },
  [ErrorCode.UNEXPECTED_FIELD]: {
    code: ErrorCode.UNEXPECTED_FIELD,
    sdkClassName: 'UnexpectedFieldCredenceError',
    kind: 'api',
    httpStatus: null,
    defaultMessage: 'Unexpected field',
  },
  [ErrorCode.VALUE_TOO_SMALL]: {
    code: ErrorCode.VALUE_TOO_SMALL,
    sdkClassName: 'ValueTooSmallCredenceError',
    kind: 'api',
    httpStatus: null,
    defaultMessage: 'Value is too small',
  },
  [ErrorCode.VALUE_TOO_LARGE]: {
    code: ErrorCode.VALUE_TOO_LARGE,
    sdkClassName: 'ValueTooLargeCredenceError',
    kind: 'api',
    httpStatus: null,
    defaultMessage: 'Value is too large',
  },
  [ErrorCode.INSUFFICIENT_FUNDS]: {
    code: ErrorCode.INSUFFICIENT_FUNDS,
    sdkClassName: 'InsufficientFundsCredenceError',
    kind: 'api',
    httpStatus: 422,
    defaultMessage: 'Insufficient funds',
  },
  [ErrorCode.UNAUTHORIZED]: {
    code: ErrorCode.UNAUTHORIZED,
    sdkClassName: 'UnauthorizedCredenceError',
    kind: 'api',
    httpStatus: 401,
    defaultMessage: 'Unauthorized access',
  },
  [ErrorCode.FORBIDDEN]: {
    code: ErrorCode.FORBIDDEN,
    sdkClassName: 'ForbiddenCredenceError',
    kind: 'api',
    httpStatus: 403,
    defaultMessage: 'Forbidden access',
  },
  [ErrorCode.NOT_FOUND]: {
    code: ErrorCode.NOT_FOUND,
    sdkClassName: 'NotFoundCredenceError',
    kind: 'api',
    httpStatus: 404,
    defaultMessage: 'Resource not found',
  },
  [ErrorCode.CONFLICT]: {
    code: ErrorCode.CONFLICT,
    sdkClassName: 'ConflictCredenceError',
    kind: 'api',
    httpStatus: 409,
    defaultMessage: 'Conflict',
  },
  [ErrorCode.BATCH_SIZE_EXCEEDED]: {
    code: ErrorCode.BATCH_SIZE_EXCEEDED,
    sdkClassName: 'BatchSizeExceededCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'Batch size exceeded',
  },
  [ErrorCode.BATCH_SIZE_TOO_SMALL]: {
    code: ErrorCode.BATCH_SIZE_TOO_SMALL,
    sdkClassName: 'BatchSizeTooSmallCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'Batch size too small',
  },
  [ErrorCode.RATE_LIMIT_EXCEEDED]: {
    code: ErrorCode.RATE_LIMIT_EXCEEDED,
    sdkClassName: 'RateLimitExceededCredenceError',
    kind: 'api',
    httpStatus: 429,
    defaultMessage: 'Rate limit exceeded',
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    code: ErrorCode.SERVICE_UNAVAILABLE,
    sdkClassName: 'ServiceUnavailableCredenceError',
    kind: 'api',
    httpStatus: 503,
    defaultMessage: 'Service temporarily unavailable',
  },
  [ErrorCode.INTERNAL_SERVER_ERROR]: {
    code: ErrorCode.INTERNAL_SERVER_ERROR,
    sdkClassName: 'InternalServerErrorCredenceError',
    kind: 'api',
    httpStatus: 500,
    defaultMessage: 'An unexpected internal server error occurred',
  },
  /** @deprecated Legacy wire code retained for backward-compatible SDK mapping. */
  invalid_input: {
    code: 'invalid_input',
    sdkClassName: 'InvalidInputCredenceError',
    kind: 'api',
    httpStatus: 400,
    defaultMessage: 'Invalid input',
    deprecated: true,
    replacedBy: ErrorCode.VALIDATION_FAILED,
  },
  sdk_request_timeout: {
    code: 'sdk_request_timeout',
    sdkClassName: 'SdkRequestTimeoutCredenceError',
    kind: 'transport',
    httpStatus: 0,
    defaultMessage: 'Request timed out',
  },
  sdk_network_error: {
    code: 'sdk_network_error',
    sdkClassName: 'SdkNetworkErrorCredenceError',
    kind: 'transport',
    httpStatus: 0,
    defaultMessage: 'Network error',
  },
  sdk_invalid_json: {
    code: 'sdk_invalid_json',
    sdkClassName: 'SdkInvalidJsonCredenceError',
    kind: 'transport',
    httpStatus: null,
    defaultMessage: 'Invalid JSON response',
  },
  sdk_unmapped_http: {
    code: 'sdk_unmapped_http',
    sdkClassName: 'SdkUnmappedHttpCredenceError',
    kind: 'transport',
    httpStatus: null,
    defaultMessage: 'Unmapped HTTP error response',
    unmappedHttpFallback: true,
  },
} as const satisfies Record<string, ErrorCatalogEntry>

export type ErrorCatalogCode = keyof typeof ERROR_CATALOG

export const ERROR_CATALOG_CODES = Object.keys(ERROR_CATALOG) as ErrorCatalogCode[]

export const API_ERROR_CATALOG_CODES = ERROR_CATALOG_CODES.filter(
  (key) => ERROR_CATALOG[key].kind === 'api',
)

export const TRANSPORT_ERROR_CATALOG_CODES = ERROR_CATALOG_CODES.filter(
  (key) => ERROR_CATALOG[key].kind === 'transport',
)

export function getCatalogEntry(code: string): ErrorCatalogEntry | undefined {
  return ERROR_CATALOG[code as ErrorCatalogCode]
}

export function getUnmappedHttpFallbackEntry(): ErrorCatalogEntry {
  const entry = ERROR_CATALOG_CODES
    .map((key) => ERROR_CATALOG[key])
    .find((item) => item.unmappedHttpFallback)
  if (!entry) {
    throw new Error('ERROR_CATALOG is missing an unmappedHttpFallback transport entry')
  }
  return entry
}
