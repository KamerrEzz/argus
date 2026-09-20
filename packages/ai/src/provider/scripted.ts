import { LLMError } from '@acr/shared';
import {
  addUsage,
  runStructured,
  type AIProvider,
  type CompletionRequest,
  type CompletionResponse,
  type StructuredRequest,
  type StructuredResult,
  type TokenUsage,
  type ToolCall,
} from './types';

export interface ScriptedTurn {
  readonly text?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Fail this turn instead of answering; used to exercise error paths. */
  readonly error?: string;
}

/**
 * Deterministic provider for unit and end-to-end tests.
 *
 * Two modes:
 * - a queue of turns, after which every call returns a terminal answer
 * - a planner function that answers from the request, for behaviour that
 *   depends on what the graph asked
 */
export class ScriptedProvider implements AIProvider {
  readonly name = 'scripted';
  readonly defaultModel = 'scripted-model';

  private readonly turns: ScriptedTurn[];
  private readonly planner?: (request: CompletionRequest, index: number) => ScriptedTurn;
  private cursor = 0;

  readonly requests: CompletionRequest[] = [];
  private tokens = { inputTokens: 0, outputTokens: 0 };

  get totalUsage(): TokenUsage {
    return this.tokens;
  }

  constructor(
    source: readonly ScriptedTurn[] | ((request: CompletionRequest, index: number) => ScriptedTurn),
  ) {
    if (typeof source === 'function') {
      this.turns = [];
      this.planner = source;
    } else {
      this.turns = [...source];
    }
  }

  get callCount(): number {
    return this.requests.length;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const turn = this.nextTurn(request);

    if (turn.error !== undefined) {
      throw new LLMError(turn.error, { details: { call: this.requests.length } });
    }

    const usage = {
      inputTokens: turn.inputTokens ?? 100,
      outputTokens: turn.outputTokens ?? 50,
    };
    this.tokens = addUsage(this.tokens, usage);

    return {
      text: turn.text ?? '',
      toolCalls: turn.toolCalls ?? [],
      usage,
      model: this.defaultModel,
      finishReason: (turn.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
    };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const response = await this.complete({
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      jsonMode: true,
    });
    const parsed = request.schema.safeParse(JSON.parse(response.text) as unknown);
    if (!parsed.success) {
      throw new LLMError('scripted provider output did not match the requested schema', {
        details: { issues: parsed.error.issues },
      });
    }
    return { value: parsed.data, usage: response.usage, model: this.defaultModel, repairs: 0 };
  }

  private nextTurn(request: CompletionRequest): ScriptedTurn {
    if (this.planner !== undefined) {
      return this.planner(request, this.cursor);
    }
    const turn = this.turns[this.cursor];
    this.cursor += 1;
    if (turn !== undefined) {
      return turn;
    }
    // Exhausted scripts end the run instead of looping forever.
    return { text: '', toolCalls: [], inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * Convenience script builder: answers `submit_findings` with the given findings
 * and otherwise finishes immediately. Most node tests only need this shape.
 */
export function findingsScript(
  findings: readonly Record<string, unknown>[],
  options: { readonly preamble?: readonly ScriptedTurn[] } = {},
): ScriptedTurn[] {
  const preamble = options.preamble ?? [];
  return [
    ...preamble,
    {
      text: 'Reporting the findings below.',
      toolCalls: [
        { id: 'call_findings_1', name: 'submit_findings', args: { findings } },
      ],
    },
  ];
}

export function terminalTurn(): ScriptedTurn {
  return { text: 'No further tool calls are needed.', toolCalls: [] };
}

export { runStructured };
