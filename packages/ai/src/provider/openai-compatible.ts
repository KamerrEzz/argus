import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { ChatOpenAI, type ChatOpenAIFields } from '@langchain/openai';
import { LLMError, type LoggerPort } from '@acr/shared';
import {
  runStructured,
  type AIProvider,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type StructuredRequest,
  type StructuredResult,
  type TokenUsage,
  type ToolSpec,
} from './types';

export interface OpenAiCompatibleOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly logger: LoggerPort;
  /** Extra request headers, e.g. OpenRouter app attribution. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Any OpenAI-compatible chat-completions endpoint (OpenAI, Groq, Together,
 * vLLM, LiteLLM, Azure gateways). The Chat Completions API is pinned because
 * the Responses API is not implemented by most compatible gateways.
 */
export class OpenAiCompatibleProvider implements AIProvider {
  readonly name = 'openai-compatible';
  readonly defaultModel: string;

  private readonly textClient: ChatOpenAI;
  private readonly jsonClient: ChatOpenAI;
  private readonly baseFields: ChatOpenAIFields;
  private readonly logger: LoggerPort;

  constructor(options: OpenAiCompatibleOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new LLMError('no API key configured for the OpenAI-compatible provider', {
        details: { baseUrl: options.baseUrl, model: options.model },
      });
    }
    this.defaultModel = options.model;
    this.logger = options.logger;

    const base: ChatOpenAIFields = {
      model: options.model,
      apiKey: options.apiKey,
      temperature: options.temperature,
      maxTokens: options.maxOutputTokens,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
      useResponsesApi: false,
      configuration: {
        baseURL: options.baseUrl,
        ...(options.headers === undefined || Object.keys(options.headers).length === 0
          ? {}
          : { defaultHeaders: { ...options.headers } }),
      },
    };

    this.baseFields = base;
    this.textClient = new ChatOpenAI({ ...base });
    this.jsonClient = new ChatOpenAI({
      ...base,
      modelKwargs: { response_format: { type: 'json_object' } },
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const client = this.pickClient(request);
    const messages = toLangChainMessages(request.messages);
    const bound =
      request.tools === undefined || request.tools.length === 0
        ? client
        : client.bindTools(request.tools.map(toOpenAiToolSpec));

    try {
      const answer = await bound.invoke(messages, {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      const text = extractText(answer.content);
      const usage = extractUsage(answer.usage_metadata);
      const toolCalls = (answer.tool_calls ?? []).map((call) => ({
        id: call.id ?? `${call.name}-${Math.random().toString(36).slice(2, 8)}`,
        name: call.name,
        args: (call.args ?? {}) as Record<string, unknown>,
      }));

      this.logger.debug(
        {
          provider: this.name,
          model: answer.response_metadata?.['model_name'] ?? this.defaultModel,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          toolCalls: toolCalls.length,
        },
        'provider completion',
      );

      return {
        text,
        toolCalls,
        usage,
        model: String(answer.response_metadata?.['model_name'] ?? this.defaultModel),
        finishReason: String(answer.response_metadata?.['finish_reason'] ?? 'stop'),
      };
    } catch (error) {
      if (error instanceof LLMError) {
        throw error;
      }
      throw new LLMError(describeProviderFailure(error), {
        details: { model: request.model ?? this.defaultModel, tools: request.tools?.length ?? 0 },
        cause: error,
      });
    }
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured(this, request);
  }

  private pickClient(request: CompletionRequest): ChatOpenAI {
    if (request.jsonMode === true) {
      return this.jsonClient;
    }
    const overridesModelOrTemp = request.model !== undefined || request.temperature !== undefined;
    if (!overridesModelOrTemp) {
      return this.textClient;
    }
    return new ChatOpenAI({
      ...this.baseFields,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
    });
  }
}

function toOpenAiToolSpec(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toLangChainMessages(messages: readonly ChatMessage[]): BaseMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
        return new SystemMessage(message.content);
      case 'user':
        return new HumanMessage(message.content);
      case 'assistant':
        return new AIMessage(message.content);
      case 'tool':
        return new ToolMessage({
          content: message.content,
          tool_call_id: message.toolCallId ?? 'unknown_tool_call',
          ...(message.name === undefined ? {} : { name: message.name }),
        });
      default:
        return new HumanMessage(message.content);
    }
  });
}

type ContentPart = { type?: string; text?: string } | string;

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return (content as ContentPart[])
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

function extractUsage(usage: unknown): TokenUsage {
  const record = usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    inputTokens: typeof record?.input_tokens === 'number' ? record.input_tokens : 0,
    outputTokens: typeof record?.output_tokens === 'number' ? record.output_tokens : 0,
  };
}

function describeProviderFailure(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    const suffix = status === undefined ? '' : ` (HTTP ${status})`;
    return `${error.message}${suffix}`;
  }
  return String(error);
}
