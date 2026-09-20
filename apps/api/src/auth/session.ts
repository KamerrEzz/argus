import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@acr/config';
import { UnauthorizedError } from '@acr/shared';

export const SESSION_AUDIENCE = 'acr-api';
export const SESSION_ISSUER = 'ai-code-review-agent';

export interface SessionClaims {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly role: 'admin' | 'member';
  /** Bumped to revoke every session a user holds. */
  readonly ver: number;
  readonly jti: string;
}

export interface SessionSubject {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: 'admin' | 'member';
  readonly tokenVersion: number;
}

function key(config: AppConfig): Uint8Array {
  return new TextEncoder().encode(config.auth.secret);
}

export async function signSession(
  subject: SessionSubject,
  config: AppConfig,
): Promise<{ token: string; maxAgeSeconds: number }> {
  const maxAgeSeconds = config.auth.sessionTtlSeconds;
  const token = await new SignJWT({
    email: subject.email,
    name: subject.name,
    role: subject.role,
    ver: subject.tokenVersion,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(subject.id)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAgeSeconds)
    .sign(key(config));

  return { token, maxAgeSeconds };
}

export async function verifySession(token: string, config: AppConfig): Promise<SessionClaims> {
  const verified = await jwtVerify(token, key(config), {
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  }).catch(() => {
    throw new UnauthorizedError('Session is invalid or has expired');
  });

  const { payload } = verified;
  const role = payload['role'];
  const ver = payload['ver'];
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string' ||
    typeof payload['email'] !== 'string' ||
    typeof payload['name'] !== 'string' ||
    (role !== 'admin' && role !== 'member') ||
    typeof ver !== 'number'
  ) {
    throw new UnauthorizedError('Session payload is malformed');
  }

  return { sub: payload.sub, email: payload['email'], name: payload['name'], role, ver, jti: payload.jti };
}

export interface CookieOptions {
  readonly path: string;
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly maxAge: number;
}

export function sessionCookieOptions(config: AppConfig, maxAgeSeconds: number): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.auth.secureCookies,
    maxAge: maxAgeSeconds,
  };
}
