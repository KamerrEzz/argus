import type { CommandRunResult, CommandSpec, ExecutionStatus } from '@acr/shared';

export const MAX_CAPTURED_OUTPUT_BYTES = 512 * 1024;

export interface OutputCollector {
  readonly chunks: Buffer[];
  bytes: number;
  truncated: boolean;
  append(chunk: Buffer): void;
  toString(): string;
  byteLength(): number;
}

export function createOutputCollector(limit = MAX_CAPTURED_OUTPUT_BYTES): OutputCollector {
  const collector: OutputCollector = {
    chunks: [],
    bytes: 0,
    truncated: false,
    append(chunk: Buffer): void {
      if (collector.bytes >= limit) {
        collector.truncated = true;
        return;
      }
      const remaining = limit - collector.bytes;
      if (chunk.length > remaining) {
        collector.chunks.push(chunk.subarray(0, remaining));
        collector.bytes = limit;
        collector.truncated = true;
        return;
      }
      collector.chunks.push(chunk);
      collector.bytes += chunk.length;
    },
    toString(): string {
      const text = Buffer.concat(collector.chunks).toString('utf8');
      return collector.truncated ? `${text}\n...[output truncated at ${limit} bytes]` : text;
    },
    byteLength(): number {
      return collector.bytes;
    },
  };
  return collector;
}

export interface StructuredCommandResult {
  readonly status: ExecutionStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly failureReason: string | null;
}

export function buildResult(input: {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: OutputCollector;
  readonly stderr: OutputCollector;
  readonly durationMs: number;
  readonly failureReason?: string | null;
}): StructuredCommandResult {
  const status: ExecutionStatus = input.timedOut
    ? 'timed_out'
    : input.exitCode === 0
      ? 'succeeded'
      : 'failed';
  return {
    status,
    exitCode: input.exitCode,
    stdout: input.stdout.toString(),
    stderr: input.stderr.toString(),
    durationMs: input.durationMs,
    timedOut: input.timedOut,
    failureReason: input.failureReason ?? null,
  };
}

export function toCommandRunResult(
  result: StructuredCommandResult,
  spec: CommandSpec,
  sandbox: 'docker' | 'process',
  display: string,
): CommandRunResult {
  return {
    status: result.status,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    sandbox,
    image: spec.image,
    command: display,
  };
}
