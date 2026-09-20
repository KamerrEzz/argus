export type ErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'timeout'
  | 'webhook_signature_invalid'
  | 'github_api_error'
  | 'llm_error'
  | 'sandbox_error'
  | 'database_error'
  | 'queue_error'
  | 'agent_error'
  | 'configuration_error'
  | 'permission_denied'
  | 'approval_required'
  | 'injection_suspected'
  | 'internal_error';

export interface ErrorResponseBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: unknown;
    readonly requestId?: string;
  };
}

export interface AppErrorOptions {
  readonly code?: ErrorCode;
  readonly httpStatus?: number;
  readonly details?: unknown;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  budget_exceeded: 422,
  timeout: 504,
  webhook_signature_invalid: 401,
  github_api_error: 502,
  llm_error: 502,
  sandbox_error: 500,
  database_error: 500,
  queue_error: 503,
  agent_error: 500,
  configuration_error: 500,
  permission_denied: 403,
  approval_required: 409,
  injection_suspected: 400,
  internal_error: 500,
};

const RETRYABLE_CODES = new Set<ErrorCode>([
  'rate_limited',
  'timeout',
  'github_api_error',
  'llm_error',
  'queue_error',
  'database_error',
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;
  readonly retryable: boolean;
  readonly expose: boolean;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'internal_error';
    this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[this.code];
    this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(this.code);
    this.expose = this.code !== 'internal_error';
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super(message, { code: 'validation_error', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { code: 'unauthorized' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Operation not permitted') {
    super(message, { code: 'forbidden' });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', details?: unknown) {
    super(`${resource} not found`, { code: 'not_found', details });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicting state', details?: unknown) {
    super(message, { code: 'conflict', details });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded', details?: unknown) {
    super(message, { code: 'rate_limited', details, retryable: true });
  }
}

export class TimeoutError extends AppError {
  constructor(message = 'Operation timed out', details?: unknown) {
    super(message, { code: 'timeout', details, retryable: true });
  }
}

export class BudgetExceededError extends AppError {
  readonly limit: string;

  constructor(limit: string, details?: unknown) {
    super(`Review budget exceeded: ${limit}`, { code: 'budget_exceeded', details });
    this.limit = limit;
  }
}

export class WebhookVerificationError extends AppError {
  constructor(message = 'Webhook signature verification failed') {
    super(message, { code: 'webhook_signature_invalid' });
  }
}

export class PermissionDeniedError extends AppError {
  readonly permission: string;

  constructor(permission: string, details?: unknown) {
    super(`Missing required permission: ${permission}`, {
      code: 'permission_denied',
      details,
    });
    this.permission = permission;
  }
}

export interface ExternalServiceErrorOptions {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly details?: unknown;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

export class ExternalServiceError extends AppError {
  readonly status: number | undefined;

  constructor(service: string, message: string, options: ExternalServiceErrorOptions) {
    super(`${service}: ${message}`, {
      code: options.code,
      details: options.details,
      cause: options.cause,
      retryable: options.retryable,
    });
    this.status = options.status;
  }
}

export class GitHubApiError extends ExternalServiceError {
  constructor(message: string, options: Omit<ExternalServiceErrorOptions, 'code'> = {}) {
    super('GitHub', message, { ...options, code: 'github_api_error' });
  }
}

export class LLMError extends ExternalServiceError {
  constructor(message: string, options: Omit<ExternalServiceErrorOptions, 'code'> = {}) {
    super('LLM', message, { ...options, code: 'llm_error' });
  }
}

export class SandboxError extends ExternalServiceError {
  constructor(message: string, options: Omit<ExternalServiceErrorOptions, 'code'> = {}) {
    super('Sandbox', message, { ...options, code: 'sandbox_error' });
  }
}

export class QueueError extends ExternalServiceError {
  constructor(message: string, options: Omit<ExternalServiceErrorOptions, 'code'> = {}) {
    super('Queue', message, { ...options, code: 'queue_error' });
  }
}

export class DatabaseError extends ExternalServiceError {
  constructor(message: string, options: Omit<ExternalServiceErrorOptions, 'code'> = {}) {
    super('Database', message, { ...options, code: 'database_error' });
  }
}

export class AgentError extends AppError {
  readonly stage: string;

  constructor(stage: string, message: string, options: AppErrorOptions = {}) {
    super(`Agent stage "${stage}" failed: ${message}`, { ...options, code: 'agent_error' });
    this.stage = stage;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { code: 'configuration_error', details });
  }
}

export class ApprovalRequiredError extends AppError {
  readonly action: string;

  constructor(action: string, details?: unknown) {
    super(`Human approval required for action: ${action}`, {
      code: 'approval_required',
      details,
    });
    this.action = action;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown, fallbackMessage = 'Unexpected error'): AppError {
  if (isAppError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new AppError(error.message || fallbackMessage, { cause: error });
  }
  return new AppError(fallbackMessage, { details: { value: String(error) } });
}

export interface ErrorResponseOptions {
  readonly requestId?: string;
  readonly includeDetails?: boolean;
}

export function toErrorResponse(
  error: unknown,
  options: ErrorResponseOptions = {},
): { status: number; body: ErrorResponseBody } {
  const appError = toAppError(error);
  const body: ErrorResponseBody = {
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : 'Internal server error',
      ...(options.includeDetails === true && appError.details !== undefined
        ? { details: appError.details }
        : {}),
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    },
  };
  return { status: appError.httpStatus, body };
}

export function isRetryable(error: unknown): boolean {
  return isAppError(error) ? error.retryable : false;
}
