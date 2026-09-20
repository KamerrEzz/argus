import { describe, expect, it } from 'vitest';
import { ValidationError } from '@acr/shared';
import { assertSafeGitRef, assertSafeSha, buildAuthenticatedRemoteUrl } from '@acr/sandbox';

/**
 * The clone URL is the only place a repository-controlled string meets the
 * network. These tests pin the SSRF-relevant guarantees: the host is always
 * github.com, the path is a strict `owner/name`, and the token cannot break
 * out of the userinfo segment. Git refs/shas are validated for the same
 * reason: they reach `git fetch/checkout` as arguments.
 */
describe('buildAuthenticatedRemoteUrl', () => {
  it('pins the host to github.com for normal input', () => {
    const url = buildAuthenticatedRemoteUrl('acme/demo', 'token123');
    expect(url).toBe('https://x-access-token:token123@github.com/acme/demo.git');
    expect(new URL(url).hostname).toBe('github.com');
  });

  it.each([
    'acme/../etc',
    'acme/demo/extra',
    '/acme/demo',
    'acme/demo.git ',
    'acme demo',
    'https://evil.example/acme/demo',
    'acme/demo\n.evil',
    'acme@evil.example/demo',
    '',
    '/',
  ])('rejects unsafe repository name %j', (fullName) => {
    expect(() => buildAuthenticatedRemoteUrl(fullName, 'token123')).toThrow(ValidationError);
  });

  it('URL-encodes the token so it cannot hijack the host', () => {
    const url = buildAuthenticatedRemoteUrl('acme/demo', 'tok@en/with:specials');
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('github.com');
    expect(parsed.username).toBe('x-access-token');
    expect(parsed.pathname).toBe('/acme/demo.git');
  });
});

describe('assertSafeGitRef', () => {
  it.each(['main', 'feature/cache', 'refs/pull/42/head', 'FETCH_HEAD', 'v1.2.3'])(
    'accepts %j',
    (ref) => {
      expect(() => assertSafeGitRef(ref)).not.toThrow();
    },
  );

  it.each([
    '..',
    'feature/../main',
    '-c',
    '--upload-pack=touch',
    'main/',
    'main.lock',
    '',
    'a'.repeat(256),
    'feature cac',
    'main;rm -rf',
  ])('rejects %j', (ref) => {
    expect(() => assertSafeGitRef(ref)).toThrow(ValidationError);
  });
});

describe('assertSafeSha', () => {
  it.each(['abc1234', 'a'.repeat(40), 'f'.repeat(64)])('accepts %j', (sha) => {
    expect(() => assertSafeSha(sha)).not.toThrow();
  });

  it.each(['', 'abc', 'xyz1234', '--help', 'a'.repeat(65), 'abc 123'])('rejects %j', (sha) => {
    expect(() => assertSafeSha(sha)).toThrow(ValidationError);
  });
});
