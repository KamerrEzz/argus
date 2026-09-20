import {
  BudgetExceededError,
  PermissionDeniedError,
  redactSecrets,
  safeStringify,
  truncate,
  type AgentToolContext,
  type FindingDraft,
} from '@acr/shared';
import { toolDefinition, TOOL_DEFINITIONS, type ToolName } from './definitions';
import type { ToolHandler } from './contracts';
import type { ChatMessage, ToolCall } from '../provider/types';

export interface ToolExecutionBatch {
  readonly messages: readonly ChatMessage[];
  readonly findings: readonly FindingDraft[];
  readonly succeeded: number;
  readonly failed: number;
  readonly denied: number;
  /** Tools the principal was not allowed to use, for the operator-visible summary. */
  readonly deniedTools: readonly string[];
}

export interface ExecuteToolCallsOptions {
  readonly timeoutMs: number;
}

/**
 * Own tool-execution node logic. LangGraph's built-in ToolNode is deliberately
 * not used: every call here is permission-checked, budget-checked, timed out
 * and audited before and after it runs, and a refusal is returned to the model
 * as data instead of throwing the graph away.
 */
export async function executeToolCalls(
  ctx: AgentToolContext,
  handlers: Record<ToolName, ToolHandler>,
  calls: readonly ToolCall[],
  options: ExecuteToolCallsOptions,
): Promise<ToolExecutionBatch> {
  const messages: ChatMessage[] = [];
  const findings: FindingDraft[] = [];
  const deniedTools: string[] = [];
  let succeeded = 0;
  let failed = 0;
  let denied = 0;

  for (const call of calls) {
    const startedAt = new Date();
    const definition = toolDefinition(call.name);
    let status: 'succeeded' | 'failed' | 'denied' = 'failed';
    let output: string;
    let metadata: Record<string, unknown> | null = null;
    let error: string | null = null;

    if (definition === null) {
      output = `Unknown tool "${call.name}". Available tools: ${TOOL_DEFINITIONS.map(
        (tool) => tool.name,
      ).join(', ')}.`;
      error = 'unknown_tool';
      failed += 1;
    } else if (!ctx.principal.permissions.has(definition.permission)) {
      status = 'denied';
      denied += 1;
      deniedTools.push(definition.name);
      output = `Refused: this review is not granted the "${definition.permission}" permission required by ${definition.name}. Continue with the tools you can use.`;
      error = `permission_denied:${definition.permission}`;
    } else {
      try {
        ctx.budget.recordToolCall();
        ctx.budget.checkToolCalls();
        const handler = handlers[definition.name];
        const result = await withTimeout(handler(call.args), options.timeoutMs, definition.name);
        status = result.isError ? 'failed' : 'succeeded';
        if (result.isError) {
          failed += 1;
        } else {
          succeeded += 1;
        }
        output = result.output;
        metadata = result.metadata;
        findings.push(...result.findings);
        if (result.isError) {
          error = 'tool_reported_failure';
        }
      } catch (runError) {
        status = classifyFailure(runError);
        failed += status === 'failed' ? 1 : 0;
        denied += status === 'denied' ? 1 : 0;
        if (status === 'denied') {
          deniedTools.push(definition.name);
        }
        output = describeFailure(definition.name, runError);
        error = redactSecrets(runError instanceof Error ? runError.message : String(runError)).slice(0, 500);
      }
    }

    const finishedAt = new Date();
    await ctx.recordToolCall({
      tool: call.name,
      status,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      inputMetadata: sanitizeInput(call.args),
      outputMetadata: metadata ?? (error === null ? null : { error }),
      error,
    });

    messages.push({
      role: 'tool',
      content: truncate(redactSecrets(`${status.toUpperCase()} ${call.name}: ${output}`), 14_000),
      toolCallId: call.id,
      name: call.name,
    });
  }

  return { messages, findings, succeeded, failed, denied, deniedTools };
}

function classifyFailure(error: unknown): 'succeeded' | 'failed' | 'denied' {
  if (error instanceof PermissionDeniedError) {
    return 'denied';
  }
  if (error instanceof BudgetExceededError) {
    return 'denied';
  }
  return 'failed';
}

function describeFailure(tool: string, error: unknown): string {
  if (error instanceof PermissionDeniedError) {
    return `Refused: permission "${error.permission}" is not granted to this agent.`;
  }
  if (error instanceof BudgetExceededError) {
    return `Stopped: review budget limit "${error.limit}" was reached. Summarise what you know and call submit_findings now.`;
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return `Rejected the arguments for ${tool}: ${truncate(error.message, 900)}. Call it again with valid arguments.`;
  }
  if (error instanceof TimeoutSignal) {
    return `${tool} timed out after ${error.timeoutMs}ms. Do not retry it; work from the evidence you already have.`;
  }
  return `${tool} failed: ${truncate(error instanceof Error ? error.message : String(error), 900)}`;
}

class TimeoutSignal extends Error {
  readonly timeoutMs: number;
  constructor(tool: string, timeoutMs: number) {
    super(`${tool} timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeout';
    this.timeoutMs = timeoutMs;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, tool: string): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutSignal(tool, timeoutMs)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Argument metadata is persisted, so only keep small, non-secret keys. */
function sanitizeInput(args: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 200) {
      output[key] = `${value.slice(0, 200)}...`;
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
    } else {
      output[key] = safeStringify(value, 200);
    }
  }
  return output;
}
