import { createSign } from 'node:crypto';
import { ConfigurationError } from '@acr/shared';

export interface JwtClaims {
  readonly iss: string;
  readonly iat: number;
  readonly exp: number;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Minimal RS256 JWT signer. The GitHub App authentication flow needs exactly
 * one claim shape, so a full JWT library would only add production surface.
 */
export function signRs256Jwt(claims: JwtClaims, privateKeyPem: string): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let signature: string;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    signature = signer.sign(privateKeyPem).toString('base64url');
  } catch (error) {
    // A malformed PEM surfaces as a raw OpenSSL error; callers expect an
    // AppError with a stable code instead of a crypto stack leaking upward.
    throw new ConfigurationError('GitHub App private key could not be used to sign the JWT', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return `${signingInput}.${signature}`;
}

export function decodeJwtPayload(token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
