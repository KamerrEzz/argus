import type { AppConfig, LlmProviderId } from '@acr/config';
import type { LoggerPort } from '@acr/shared';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { AIProvider } from './types';

/** Default base URLs for the named presets; `openai-compatible` stays explicit. */
const DEFAULT_BASE_URLS: Readonly<Record<LlmProviderId, string>> = {
  'openai-compatible': '',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'nan-builders': 'https://api.nan.builders/v1',
};

export interface LlmEndpoint {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Resolves the effective endpoint for the configured provider: an explicit
 * LLM_BASE_URL always wins, otherwise the preset default applies. OpenRouter's
 * optional app-attribution headers are attached only for that provider, and
 * only when set.
 */
export function resolveLlmEndpoint(
  llm: Pick<AppConfig['llm'], 'provider' | 'baseUrl' | 'httpReferer' | 'appTitle'>,
): LlmEndpoint {
  const explicit = llm.baseUrl.trim();
  const baseUrl = explicit.length > 0 ? explicit : DEFAULT_BASE_URLS[llm.provider];

  const headers: Record<string, string> = {};
  if (llm.provider === 'openrouter') {
    if (llm.httpReferer.trim().length > 0) {
      headers['HTTP-Referer'] = llm.httpReferer.trim();
    }
    if (llm.appTitle.trim().length > 0) {
      headers['X-OpenRouter-Title'] = llm.appTitle.trim();
    }
  }

  return { baseUrl, headers };
}

/**
 * Builds the configured provider. `openai`, `openrouter`, `nan-builders` and
 * `openai-compatible` all share one client: they expose the same OpenAI
 * Chat Completions surface, and differ only in their default base URL.
 */
export function createProvider(config: AppConfig, logger: LoggerPort): AIProvider {
  const { llm } = config;
  const { baseUrl, headers } = resolveLlmEndpoint(llm);

  return new OpenAiCompatibleProvider({
    apiKey: llm.apiKey,
    baseUrl,
    model: llm.model,
    temperature: llm.temperature,
    maxOutputTokens: llm.maxOutputTokens,
    timeoutMs: llm.requestTimeoutMs,
    maxRetries: llm.maxRetries,
    logger,
    headers,
  });
}

export { OpenAiCompatibleProvider };
export type { OpenAiCompatibleOptions } from './openai-compatible';
export { ScriptedProvider, findingsScript, terminalTurn } from './scripted';
export type { ScriptedTurn } from './scripted';
export {
  addUsage,
  emptyUsage,
  jsonSchemaOf,
  runStructured,
  EMPTY_COMPLETION,
} from './types';
export type {
  AIProvider,
  ChatMessage,
  ChatRole,
  CompletionRequest,
  CompletionResponse,
  StructuredRequest,
  StructuredResult,
  TokenUsage,
  ToolCall,
  ToolSpec,
} from './types';
