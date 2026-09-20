export interface LoggerPort {
  debug(context: Record<string, unknown>, message?: string): void;
  info(context: Record<string, unknown>, message?: string): void;
  warn(context: Record<string, unknown>, message?: string): void;
  error(context: Record<string, unknown>, message?: string): void;
  child(bindings: Record<string, unknown>): LoggerPort;
}

const NOOP = (): void => undefined;

export const noopLogger: LoggerPort = {
  debug: NOOP,
  info: NOOP,
  warn: NOOP,
  error: NOOP,
  child: () => noopLogger,
};

export interface LogContext {
  readonly requestId?: string;
  readonly reviewRunId?: string;
  readonly repositoryId?: string;
  readonly pullRequestId?: string;
  readonly jobId?: string;
  readonly agentExecutionId?: string;
  readonly nodeName?: string;
}

export function mergeLogContext(
  base: LogContext,
  extra: LogContext | Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}
