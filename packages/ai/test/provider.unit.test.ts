import { describe, expect, it } from 'vitest';
import { resolveLlmEndpoint } from '@acr/ai';
import type { AppConfig } from '@acr/config';

type Provider = AppConfig['llm']['provider'];

function resolve(
  provider: Provider,
  baseUrl: string,
  httpReferer = '',
  appTitle = '',
): ReturnType<typeof resolveLlmEndpoint> {
  return resolveLlmEndpoint({ provider, baseUrl, httpReferer, appTitle });
}

describe('resolveLlmEndpoint — base URL presets', () => {
  it('uses the explicit base URL when set, regardless of provider', () => {
    expect(resolve('openai-compatible', 'https://gateway.internal/v1').baseUrl).toBe(
      'https://gateway.internal/v1',
    );
    expect(resolve('openrouter', 'https://proxy.example/v1').baseUrl).toBe(
      'https://proxy.example/v1',
    );
  });

  it('falls back to the OpenAI public endpoint', () => {
    expect(resolve('openai', '').baseUrl).toBe('https://api.openai.com/v1');
  });

  it('falls back to the OpenRouter endpoint', () => {
    expect(resolve('openrouter', '').baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('falls back to the nan.builders endpoint', () => {
    expect(resolve('nan-builders', '').baseUrl).toBe('https://api.nan.builders/v1');
  });

  it('keeps an openai-compatible deployment explicit (no ambient default)', () => {
    expect(resolve('openai-compatible', '').baseUrl).toBe('');
  });

  it('trims a whitespace-only base URL down to the preset', () => {
    expect(resolve('nan-builders', '   ').baseUrl).toBe('https://api.nan.builders/v1');
  });
});

describe('resolveLlmEndpoint — OpenRouter attribution headers', () => {
  it('sends both headers when configured, trimmed', () => {
    expect(resolve('openrouter', '', '  https://acme.dev  ', '  ACR  ').headers).toEqual({
      'HTTP-Referer': 'https://acme.dev',
      'X-OpenRouter-Title': 'ACR',
    });
  });

  it('sends only the headers that are set', () => {
    expect(resolve('openrouter', '', '', 'ACR').headers).toEqual({ 'X-OpenRouter-Title': 'ACR' });
    expect(resolve('openrouter', '', 'https://acme.dev', '').headers).toEqual({
      'HTTP-Referer': 'https://acme.dev',
    });
  });

  it('sends no attribution headers when neither value is set', () => {
    expect(resolve('openrouter', '').headers).toEqual({});
  });

  it('never leaks attribution headers to other providers', () => {
    expect(resolve('openai', '', 'https://acme.dev', 'ACR').headers).toEqual({});
    expect(resolve('nan-builders', '', 'https://acme.dev', 'ACR').headers).toEqual({});
    expect(resolve('openai-compatible', 'https://x/v1', 'https://acme.dev', 'ACR').headers).toEqual(
      {},
    );
  });
});
