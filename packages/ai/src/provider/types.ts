import { z, type ZodType } from 'zod';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  /** Present when role === 'tool': the call this message answers. */
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. */
  readonly parameters: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Ask the provider for a single JSON object answer. */
  readonly jsonMode?: boolean;
  readonly signal?: AbortSignal;
}

export interface CompletionResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage;
  readonly model: string;
  readonly finishReason: string;
}

export interface StructuredRequest<T> {
  readonly system: string;
  readonly user: string;
  readonly schema: ZodType<T>;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface StructuredResult<T> {
  readonly value: T;
  readonly usage: TokenUsage;
  readonly model: string;
  /** Number of extra round-trips spent repairing invalid JSON/schema output. */
  readonly repairs: number;
}

/**
 * The single seam between the review graph and any LLM backend. Everything
 * above this interface is provider agnostic and unit testable with the scripted
 * provider.
 */
export interface AIProvider {
  readonly name: string;
  readonly defaultModel: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export const EMPTY_COMPLETION: CompletionResponse = {
  text: '',
  toolCalls: [],
  usage: emptyUsage(),
  model: 'unknown',
  finishReason: 'stop',
};

/** Default structured-output implementation: JSON mode plus one repair round-trip. */
export async function runStructured<T>(
  provider: Pick<AIProvider, 'complete' | 'defaultModel'>,
  request: StructuredRequest<T>,
  maxRepairs = 1,
): Promise<StructuredResult<T>> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${request.system}\n\nAnswer with a single JSON object and nothing else. Its shape must satisfy this JSON Schema:\n${JSON.stringify(
        jsonSchemaOf(request.schema),
      )}`,
    },
    { role: 'user', content: request.user },
  ];

  let usage = emptyUsage();
  let model = provider.defaultModel;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const response = await provider.complete({
      messages,
      jsonMode: true,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    usage = addUsage(usage, response.usage);
    model = response.model;

    const parsed = request.schema.safeParse(parseJson(response.text));
    if (parsed.success) {
      return { value: parsed.data, usage, model, repairs: attempt };
    }

    if (attempt === maxRepairs) {
      throw new Error(
        `provider output did not match the expected schema: ${formatIssues(parsed.error)}`,
      );
    }
    messages.push({ role: 'assistant', content: response.text.slice(0, 4000) });
    messages.push({
      role: 'user',
      content: `That answer was not valid. Problems: ${formatIssues(
        parsed.error,
      )}. Reply again with only corrected JSON.`,
    });
  }

  throw new Error('unreachable');
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('no JSON object found in provider output');
  }
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

function formatIssues(error: { issues: readonly { path: readonly (string | number | symbol)[]; message: string }[] }): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Best-effort JSON Schema export used to steer the model. Zod stays the single
 * source of truth; if a schema cannot be exported we still require the answer
 * to validate against it, so the contract never silently weakens.
 */
export function jsonSchemaOf(schema: ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  } catch {
    return { note: 'schema is not statically exportable; follow the field names given in the prompt' };
  }
}
