import {
  createPublicKey,
  generateKeyPairSync,
  verify as cryptoVerify,
} from 'node:crypto';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { GithubAppAuth, decodeJwtPayload, signRs256Jwt } from '@acr/github';
import { createConfig, parseEnv } from '@acr/config';
import { ConfigurationError, type AppError } from '@acr/shared';

const CLAIMS = { iss: '12345', iat: 1_700_000_000, exp: 1_700_000_540 } as const;

let privateKeyPem: string;
let publicKeyPem: string;
let otherPublicKeyPem: string;

function verifyTokenSignature(token: string, keyPem: string): boolean {
  const [header, payload, signature] = token.split('.');
  if (header === undefined || payload === undefined || signature === undefined) {
    return false;
  }
  return cryptoVerify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`, 'utf8'),
    createPublicKey(keyPem),
    Buffer.from(signature, 'base64url'),
  );
}

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  expect(segment).toBeTypeOf('string');
  return JSON.parse(Buffer.from(segment ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function appAuth(privateKey: string, appId: number | null = 12345): GithubAppAuth {
  return new GithubAppAuth({
    appId,
    privateKey,
    apiBaseUrl: 'https://api.github.com',
    requestTimeoutMs: 20_000,
    tokenCacheSkewSeconds: 60,
    maxRetries: 0,
    maxPages: 1,
    userAgent: 'acr-unit-test',
    fallbackToken: '',
  });
}

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  privateKeyPem = pair.privateKey;
  publicKeyPem = pair.publicKey;
  otherPublicKeyPem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).publicKey;
});

describe('signRs256Jwt — structure and signature', () => {
  it('produces three base64url segments', () => {
    const token = signRs256Jwt(CLAIMS, privateKeyPem);
    const segments = token.split('.');
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('declares RS256 in the header', () => {
    const [header] = signRs256Jwt(CLAIMS, privateKeyPem).split('.');
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('carries the exact claims in the payload segment', () => {
    const parts = signRs256Jwt(CLAIMS, privateKeyPem).split('.');
    expect(decodeSegment(parts[1])).toEqual({ iss: '12345', iat: 1_700_000_000, exp: 1_700_000_540 });
  });

  it('signs the exact `header.payload` bytes so the signature verifies', () => {
    const token = signRs256Jwt(CLAIMS, privateKeyPem);
    expect(verifyTokenSignature(token, publicKeyPem)).toBe(true);
  });

  it('rejects verification under a different key pair', () => {
    const token = signRs256Jwt(CLAIMS, privateKeyPem);
    expect(verifyTokenSignature(token, otherPublicKeyPem)).toBe(false);
  });

  it('rejects verification when any claim byte is tampered with', () => {
    const token = signRs256Jwt(CLAIMS, privateKeyPem);
    const [header, payload, signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ iss: 'evil', iat: 0, exp: 9_999_999_999 }),
      'utf8',
    ).toString('base64url');
    expect(forgedPayload).not.toBe(payload);
    const tampered = `${header}.${forgedPayload}.${signature}`;
    expect(verifyTokenSignature(tampered as string, publicKeyPem)).toBe(false);
    // The untouched original still verifies — only the payload moved.
    expect(verifyTokenSignature(token, publicKeyPem)).toBe(true);
  });
});

describe('decodeJwtPayload', () => {
  it('round-trips the claims of a signed token', () => {
    const token = signRs256Jwt(CLAIMS, privateKeyPem);
    expect(decodeJwtPayload(token)).toEqual({
      iss: '12345',
      iat: 1_700_000_000,
      exp: 1_700_000_540,
    });
  });

  it('returns null for malformed tokens', () => {
    for (const junk of ['a.b', 'a.b.c.d', 'not-a-jwt', 'x.y.z', '', '...']) {
      expect(decodeJwtPayload(junk)).toBeNull();
    }
  });
});

describe('GithubAppAuth.createAppJwt — claims and skew', () => {
  // Mirrors packages/github/src/auth.ts: iat is pushed 60s into the past to
  // absorb clock drift, exp lasts 9 minutes (GitHub's 10-minute JWT cap).
  it('issues a verifiable app JWT with iss, back-dated iat and 9-minute exp', () => {
    const nowSeconds = 1_757_000_000;
    const token = appAuth(privateKeyPem).createAppJwt(nowSeconds);

    const claims = decodeJwtPayload(token);
    expect(claims).toEqual({
      iss: '12345',
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
    });
    expect(verifyTokenSignature(token, publicKeyPem)).toBe(true);
  });

  it('keeps the total lifetime at 10 minutes including the clock skew', () => {
    const nowSeconds = 1_757_000_000;
    const claims = decodeJwtPayload(appAuth(privateKeyPem).createAppJwt(nowSeconds));
    const typed = claims as { iat: number; exp: number };
    expect(typed.exp - typed.iat).toBe(600);
    expect(typed.exp).toBeLessThanOrEqual(nowSeconds + 9 * 60);
  });

  it('refuses to sign without an App id', () => {
    let caught: unknown;
    try {
      appAuth(privateKeyPem, null).createAppJwt(1_757_000_000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as AppError).code).toBe('configuration_error');
    expect((caught as AppError).message).toBe('GITHUB_APP_ID is not configured');
  });

  it('refuses to sign without a configured private key', () => {
    expect(() => appAuth('').createAppJwt()).toThrow(ConfigurationError);
    expect(() => appAuth('   \n  ').createAppJwt()).toThrow(ConfigurationError);
  });
});

describe('private key shapes through the config path', () => {
  it('signs from a PEM delivered via GITHUB_PRIVATE_KEY with \\n escapes restored', () => {
    const escaped = privateKeyPem.replace(/\r?\n/g, '\\n');
    expect(escaped).not.toContain('\n');

    const raw = parseEnv({ GITHUB_PRIVATE_KEY: escaped });
    expect(raw.GITHUB_PRIVATE_KEY).toBe(privateKeyPem);

    const config = createConfig(raw, { workspaceRoot: tmpdir() });
    expect(config.github.privateKey).toBe(privateKeyPem);

    const token = signRs256Jwt(CLAIMS, config.github.privateKey);
    expect(verifyTokenSignature(token, publicKeyPem)).toBe(true);
  });

  it('signs from a literal PEM string', () => {
    const token = signRs256Jwt(CLAIMS, privateKeyPem);
    expect(verifyTokenSignature(token, publicKeyPem)).toBe(true);
  });
});

describe('malformed keys fail fast as AppErrors', () => {
  const BAD_KEYS = [
    'garbage-not-a-pem',
    '',
    '-----BEGIN PRIVATE KEY-----\nnotbase64@@@\n-----END PRIVATE KEY-----',
    'ssh-rsa AAAAB3NzaC1yc2E@wrong.format',
  ];

  for (const [index, badKey] of BAD_KEYS.entries()) {
    it(`rejects malformed key #${index} with a configuration_error AppError, not a raw crypto error`, () => {
      let caught: unknown;
      try {
        signRs256Jwt(CLAIMS, badKey);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      const appError = caught as AppError;
      expect(appError.code).toBe('configuration_error');
      expect(appError.message).toBe('GitHub App private key could not be used to sign the JWT');
      const details = appError.details as { reason?: unknown };
      expect(typeof details.reason).toBe('string');
      expect((details.reason as string).length).toBeGreaterThan(0);
    });
  }
});
