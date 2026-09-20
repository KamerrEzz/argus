import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createConfig, parseEnv, type AppConfig } from '@acr/config';
import { AppError, UnauthorizedError } from '@acr/shared';
import {
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  sessionCookieOptions,
  signSession,
  verifySession,
  type SessionSubject,
} from './auth/session';

// ---------------------------------------------------------------------------
// All secrets are built in-test. The repo .env is never consulted: parseEnv({})
// pins every value to the defaults documented in packages/config/src/env.ts.
// ---------------------------------------------------------------------------

const SECRET_A = 'unit-test-session-secret-alpha-0123456789abcdef';
const SECRET_B = 'unit-test-session-secret-bravo-0123456789abcdef';

function sessionConfig(secret: string, env: 'development' | 'production' = 'development'): AppConfig {
  return createConfig(parseEnv({ NODE_ENV: env, AUTH_SECRET: secret }), {
    workspaceRoot: '/acr-unit-test',
  });
}

const CONFIG_A = sessionConfig(SECRET_A);
const CONFIG_B = sessionConfig(SECRET_B);

const SUBJECT: SessionSubject = {
  id: 'user-1',
  email: 'dev@acme.test',
  name: 'Dev Person',
  role: 'member',
  tokenVersion: 3,
};

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** A correctly-signed token whose claims/issuers can be pointed anywhere. */
async function forgedToken(
  secret: string,
  claims: Record<string, unknown>,
  overrides: { issuer?: string; audience?: string; expiresAt?: number } = {},
): Promise<string> {
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(typeof claims['sub'] === 'string' ? claims['sub'] : 'user-1')
    .setIssuer(overrides.issuer ?? SESSION_ISSUER)
    .setJti('jti-forged')
    .setIssuedAt();
  if (overrides.audience !== undefined) {
    builder.setAudience(overrides.audience);
  } else {
    builder.setAudience(SESSION_AUDIENCE);
  }
  builder.setExpirationTime(
    overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3_600,
  );
  return builder.sign(key(secret));
}

async function expectUnauthorized(promise: Promise<unknown>): Promise<UnauthorizedError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(UnauthorizedError);
  const unauthorized = error as UnauthorizedError;
  expect(unauthorized.code).toBe('unauthorized');
  expect(unauthorized.httpStatus).toBe(401);
  return unauthorized;
}

function decodedPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  expect(typeof payload).toBe('string');
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('signSession -> verifySession round trip', () => {
  it('returns the signed claims verbatim with a fresh jti', async () => {
    const { token, maxAgeSeconds } = await signSession(SUBJECT, CONFIG_A);
    expect(maxAgeSeconds).toBe(CONFIG_A.auth.sessionTtlSeconds);
    expect(token.split('.')).toHaveLength(3);

    const claims = await verifySession(token, CONFIG_A);
    expect(claims).toEqual({
      sub: 'user-1',
      email: 'dev@acme.test',
      name: 'Dev Person',
      role: 'member',
      ver: 3,
      jti: expect.any(String),
    });
    expect(claims.jti.length).toBeGreaterThan(0);
  });

  it('tags the token with the project issuer and audience', async () => {
    const { token } = await signSession(SUBJECT, CONFIG_A);
    const payload = decodedPayload(token);
    expect(payload['iss']).toBe('ai-code-review-agent');
    expect(payload['aud']).toBe('acr-api');
    expect(payload['exp']).toBe(
      (payload['iat'] as number) + CONFIG_A.auth.sessionTtlSeconds,
    );
  });
});

describe('verifySession rejections', () => {
  it('rejects a tampered payload (role escalated member -> admin) despite a kept signature', async () => {
    const { token } = await signSession(SUBJECT, CONFIG_A);
    const payload = decodedPayload(token);
    expect(payload['role']).toBe('member');
    payload['role'] = 'admin';
    const [header = '', , signature = ''] = token.split('.');
    const tampered = `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
    expect(decodedPayload(tampered)['role']).toBe('admin');

    const error = await expectUnauthorized(verifySession(tampered, CONFIG_A));
    expect(error.message).toBe('Session is invalid or has expired');
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await signSession(SUBJECT, CONFIG_A);
    await expectUnauthorized(verifySession(token, CONFIG_B));
  });

  it('rejects a different issuer even when signed with the right secret', async () => {
    const token = await forgedToken(
      SECRET_A,
      { email: 'x@acme.test', name: 'X', role: 'member', ver: 1 },
      { issuer: 'evil-issuer' },
    );
    await expectUnauthorized(verifySession(token, CONFIG_A));
  });

  it('rejects a different audience even when signed with the right secret', async () => {
    const token = await forgedToken(
      SECRET_A,
      { email: 'x@acme.test', name: 'X', role: 'member', ver: 1 },
      { audience: 'not-acr-api' },
    );
    await expectUnauthorized(verifySession(token, CONFIG_A));
  });

  it('rejects a well-signed token whose custom claims are malformed', async () => {
    const base = { email: 'x@acme.test', name: 'X', role: 'member', ver: 1 };
    await expectUnauthorized(
      verifySession(await forgedToken(SECRET_A, { ...base, role: 'superadmin' }), CONFIG_A),
    );
    await expectUnauthorized(
      verifySession(await forgedToken(SECRET_A, { ...base, role: 1 }), CONFIG_A),
    );
    await expectUnauthorized(
      verifySession(await forgedToken(SECRET_A, { ...base, ver: '1' }), CONFIG_A),
    );
    await expectUnauthorized(
      verifySession(await forgedToken(SECRET_A, { ...base, email: 7 }), CONFIG_A),
    );
  });

  it('rejects garbage that is not a JWT at all', async () => {
    await expectUnauthorized(verifySession('not-a-jwt', CONFIG_A));
    await expectUnauthorized(verifySession('', CONFIG_A));
  });
});

describe('expiry boundary (jose: rejected when exp <= now)', () => {
  it('is accepted one second before the TTL and rejected exactly at it', async () => {
    const ttl = CONFIG_A.auth.sessionTtlSeconds;
    const signedAt = Math.floor(Date.UTC(2026, 0, 1, 12, 0, 0) / 1000); // whole second
    vi.useFakeTimers();
    vi.setSystemTime(signedAt * 1000);

    const { token } = await signSession(SUBJECT, CONFIG_A);
    expect(decodedPayload(token)['exp']).toBe(signedAt + ttl);

    // Comfortably inside the window.
    vi.setSystemTime((signedAt + 1) * 1000);
    await expect(verifySession(token, CONFIG_A)).resolves.toMatchObject({ sub: 'user-1' });

    // Last instant that must pass: now = exp - 1.
    vi.setSystemTime((signedAt + ttl - 1) * 1000);
    await expect(verifySession(token, CONFIG_A)).resolves.toMatchObject({ sub: 'user-1' });

    // AS-CODED boundary: jose rejects when `exp <= now`, so at exactly the TTL
    // the session is already expired (RFC 7519: "on or after" this time).
    vi.setSystemTime((signedAt + ttl) * 1000);
    await expectUnauthorized(verifySession(token, CONFIG_A));

    // And a second later.
    vi.setSystemTime((signedAt + ttl + 1) * 1000);
    await expectUnauthorized(verifySession(token, CONFIG_A));
  });

  it('honours a TTL configured in the test, not the real .env', async () => {
    const shortConfig = createConfig(
      parseEnv({ AUTH_SECRET: SECRET_A, AUTH_SESSION_TTL_MINUTES: '5' }),
      { workspaceRoot: '/acr-unit-test' },
    );
    expect(shortConfig.auth.sessionTtlSeconds).toBe(300);

    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const { token } = await signSession(SUBJECT, shortConfig);

    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 4, 59));
    await expect(verifySession(token, shortConfig)).resolves.toMatchObject({ role: 'member' });

    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 5, 0));
    await expectUnauthorized(verifySession(token, shortConfig));
  });
});

describe('sessionCookieOptions', () => {
  it('is a path-rooted, httpOnly, Lax cookie whose secure flag follows the config', () => {
    const dev = sessionCookieOptions(CONFIG_A, 43_200);
    expect(dev).toEqual({
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 43_200,
    });

    const prod = sessionCookieOptions(sessionConfig(SECRET_A, 'production'), 600);
    expect(prod.secure).toBe(true);
    expect(prod.maxAge).toBe(600);
  });

  it('AS-CODED: carries no cookie name — the name is config.auth.cookieName, applied by the caller', () => {
    const options = sessionCookieOptions(CONFIG_A, 1);
    expect('name' in options).toBe(false);
    // The documented default is pinned by the source schema, not the .env.
    expect(CONFIG_A.auth.cookieName).toBe(parseEnv({}).AUTH_COOKIE_NAME);
  });
});

describe('the rejection is always an exposed 401 AppError', () => {
  it('rejections are AppError subclasses the API can render directly', async () => {
    const error = await verifySession('junk', CONFIG_A).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).expose).toBe(true);
  });
});
