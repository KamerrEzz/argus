const ANSI_PATTERN = /\u001b\[[0-9;]*[a-zA-Z]/g;

const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'github_token', pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,255}\b/g },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'bearer_header', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
  {
    name: 'basic_auth_url',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/g,
  },
  {
    name: 'assignment',
    // `[\w.-]*` around the key name is what makes DB_PASSWORD / GITHUB_TOKEN /
    // APP_API_KEY match: `\b` never fires between an underscore and a letter.
    // The lookahead stops a later pass from redacting an already-redacted
    // placeholder, which would erase the information about what it was.
    pattern:
      /[\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)[\w.-]*\s*[:=]\s*(?!["']?\[REDACTED)["']?([^\s"',;]{8,})["']?/gi,
  },
];

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export function truncate(value: string, maxLength: number, suffix = '\n...[truncated]'): string {
  if (maxLength <= 0) {
    return '';
  }
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, Math.max(0, maxLength - suffix.length)) + suffix;
}

export function redactSecrets(value: string): string {
  let output = value;
  for (const { name, pattern } of SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => {
      if (name === 'assignment') {
        const separatorIndex = match.search(/[:=]/);
        if (separatorIndex === -1) {
          return `[REDACTED:${name}]`;
        }
        return `${match.slice(0, separatorIndex + 1)}[REDACTED:${name}]`;
      }
      if (name === 'basic_auth_url') {
        return match.replace(/:[^\s:@/]+@/, ':[REDACTED]@');
      }
      return `[REDACTED:${name}]`;
    });
  }
  return output;
}

export function maskToken(value: string): string {
  if (value.length <= 8) {
    return '[REDACTED]';
  }
  return `${value.slice(0, 4)}...[REDACTED]...${value.slice(-4)}`;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

export function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return lines;
}

export function safeStringify(value: unknown, maxLength = 4000): string {
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (typeof item === 'bigint') {
          return item.toString();
        }
        if (typeof item === 'object' && item !== null) {
          if (seen.has(item)) {
            return '[circular]';
          }
          seen.add(item);
        }
        return item;
      },
      2,
    );
  } catch {
    serialized = String(value);
  }
  return truncate(redactSecrets(serialized ?? 'null'), maxLength);
}

export function toTokenCountEstimate(value: string): number {
  return Math.ceil(value.length / 4);
}

export function uniqueBy<T, K>(items: readonly T[], keyOf: (item: T) => K): T[] {
  const seen = new Set<K>();
  const output: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new RangeError('chunk size must be positive');
  }
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}
