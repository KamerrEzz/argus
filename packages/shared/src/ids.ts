import { createHash, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function newCorrelationId(): string {
  return randomUUID();
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function shortHash(value: string, length = 16): string {
  return sha256Hex(value).slice(0, length);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
