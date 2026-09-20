import pino, { type Logger, type LoggerOptions } from 'pino';
import { getConfig } from './config';

export type { Logger } from 'pino';

export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  'password',
  'passwordHash',
  'apiKey',
  'llmApiKey',
  'privateKey',
  'webhookSecret',
  'authSecret',
  'secret',
  'token',
  'accessToken',
  'installationToken',
  '*.password',
  '*.passwordHash',
  '*.apiKey',
  '*.privateKey',
  '*.webhookSecret',
  '*.secret',
  '*.token',
  '*.authorization',
];

const REDACT_OPTIONS: LoggerOptions['redact'] = {
  paths: [...REDACT_PATHS],
  censor: '[REDACTED]',
};

export interface LoggerInput {
  readonly name: string;
  readonly level?: LoggerOptions['level'];
  readonly pretty?: boolean;
  readonly bindings?: Record<string, unknown>;
}

export function createLogger(input: LoggerInput): Logger {
  const options: LoggerOptions = {
    name: input.name,
    level: input.level ?? 'info',
    redact: REDACT_OPTIONS,
    // `undefined` omits the default bindings; `false` would be logged as a value.
    base: { pid: undefined, hostname: undefined },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (input.pretty === true) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }
  return pino(options);
}

let rootLogger: Logger | null = null;

export function getLogger(): Logger {
  if (rootLogger === null) {
    const config = getConfig();
    rootLogger = createLogger({
      name: 'acr',
      level: config.log.level,
      pretty: config.log.pretty,
    });
  }
  return rootLogger;
}

export function setLogger(logger: Logger | null): void {
  rootLogger = logger;
}

export function childLogger(
  bindings: Record<string, unknown>,
  parent: Logger = getLogger(),
): Logger {
  return parent.child(bindings);
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const output: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (typeof error.stack === 'string') {
      output.stack = error.stack.split('\n').slice(0, 12).join('\n');
    }
    const candidate = error as Error & { code?: unknown; details?: unknown };
    if (candidate.code !== undefined) {
      output.code = candidate.code;
    }
    if (candidate.details !== undefined) {
      output.details = candidate.details;
    }
    return output;
  }
  return { message: String(error) };
}
