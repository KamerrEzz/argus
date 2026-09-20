import { randomBytes } from 'node:crypto';
import { redactSecrets, stripAnsi, truncate } from './text';

export type InjectionSignalKind =
  | 'instruction_override'
  | 'role_spoofing'
  | 'secret_exfiltration'
  | 'tool_coercion'
  | 'delimiter_escape'
  | 'persona_override'
  | 'authority_claim'
  | 'policy_override';

export interface InjectionSignal {
  readonly kind: InjectionSignalKind;
  readonly severity: 'high' | 'medium';
  readonly snippet: string;
  readonly offset: number;
}

interface InjectionRule {
  readonly kind: InjectionSignalKind;
  readonly severity: 'high' | 'medium';
  readonly pattern: RegExp;
}

const RULES: readonly InjectionRule[] = [
  {
    kind: 'instruction_override',
    severity: 'high',
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|the)\b[^.\n]{0,20}\b(?:instruction|instructions|prompt|prompts|rule|rules|guideline|guidelines|direction|directions)\b/gi,
  },
  {
    kind: 'role_spoofing',
    severity: 'high',
    pattern: /(?:^|\n)\s*(?:system|assistant|developer|tool)\s*:\s*|<\/?(?:system|assistant|developer|tool)>|<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?(?:INST|SYS)\]/g,
  },
  {
    kind: 'secret_exfiltration',
    severity: 'high',
    pattern:
      /\b(?:print|show|reveal|expose|dump|leak|send|return|include|output)\b[^.\n]{0,60}\b(?:env|environment\s+variables?|api[\s_-]?keys?|secrets?|tokens?|credentials?|password|private\s+key|\.env)\b/gi,
  },
  {
    kind: 'tool_coercion',
    severity: 'high',
    pattern:
      /\b(?:call|invoke|execute|run|use)\b[^.\n]{0,30}\b(?:tool|function|command|shell|script|terminal)\b[^.\n]{0,80}\b(?:to|with|using|that)\b/gi,
  },
  {
    kind: 'delimiter_escape',
    severity: 'high',
    pattern: /<<\/?UNTRUSTED[^>]*>>|```\s*(?:system|assistant|developer)\b|(?:^|\n)\s*#{1,6}\s*(?:system|instructions?)\s*(?:\n|$)/gi,
  },
  {
    kind: 'persona_override',
    severity: 'medium',
    pattern:
      /\b(?:you are now|from now on you|act as (?:if you are|a)|pretend (?:to be|you are)|jailbreak|developer mode|dan mode)\b/gi,
  },
  {
    kind: 'authority_claim',
    severity: 'medium',
    pattern:
      /\b(?:this is (?:the )?(?:admin|administrator|developer|maintainer|owner)|(?:i am|i'm) (?:the )?(?:admin|administrator|developer|maintainer)|authorized by (?:the )?(?:admin|administrator|owner|maintainer))\b/gi,
  },
  {
    kind: 'policy_override',
    severity: 'medium',
    pattern:
      /\b(?:set|change|override|update)\b[^.\n]{0,30}\b(?:system prompt|temperature|max tokens|policy|rules|guardrails)\b/gi,
  },
];

const MAX_SNIPPET_LENGTH = 160;

export function detectInjectionSignals(content: string): InjectionSignal[] {
  if (content.length === 0) {
    return [];
  }
  const signals: InjectionSignal[] = [];
  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match = pattern.exec(content);
    while (match !== null) {
      signals.push({
        kind: rule.kind,
        severity: rule.severity,
        snippet: truncate(stripAnsi(match[0]).trim(), MAX_SNIPPET_LENGTH, '…'),
        offset: match.index,
      });
      if (signals.length >= 50) {
        return signals;
      }
      match = pattern.exec(content);
    }
  }
  return signals.sort((left, right) => left.offset - right.offset);
}

export function createUntrustedBoundary(): string {
  return `UNTRUSTED_${randomBytes(8).toString('hex').toUpperCase()}`;
}

export interface PreparedUntrustedContent {
  readonly content: string;
  readonly signals: readonly InjectionSignal[];
  readonly truncated: boolean;
}

export interface PrepareOptions {
  readonly maxLength: number;
  readonly boundary: string;
}

/**
 * Repository content is attacker-controlled. Before it reaches the model it is
 * normalised, stripped of any string that could forge the untrusted boundary,
 * and scanned for instruction-injection attempts.
 */
export function prepareUntrustedContent(
  content: string,
  options: PrepareOptions,
): PreparedUntrustedContent {
  const normalized = stripAnsi(content).replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  // Both the opening fence (`<<BOUNDARY>>`) and the closing fence
  // (`<<END_BOUNDARY>>`) can be forged by untrusted content, so both are
  // stripped before the block is wrapped again by the caller.
  const boundaryPattern = new RegExp(`<<\\/?(?:END_)?${options.boundary}[^>]*>>`, 'gi');
  const forgedBoundary = boundaryPattern.test(normalized);
  const stripped = normalized.replace(boundaryPattern, '[boundary-removed]');
  const signals = detectInjectionSignals(stripped);
  const redacted = redactSecrets(stripped);
  const truncated = redacted.length > options.maxLength;
  return {
    content: truncated ? truncate(redacted, options.maxLength) : redacted,
    signals: forgedBoundary
      ? [
          ...signals,
          {
            kind: 'delimiter_escape',
            severity: 'high',
            snippet: '[forged untrusted boundary removed]',
            offset: 0,
          },
        ]
      : signals,
    truncated,
  };
}

export interface UntrustedBlock {
  readonly boundary: string;
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly signals: readonly InjectionSignal[];
  readonly truncated: boolean;
}

export function buildUntrustedBlock(input: {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly maxLength: number;
  readonly boundary: string;
}): UntrustedBlock {
  const prepared = prepareUntrustedContent(input.content, {
    maxLength: input.maxLength,
    boundary: input.boundary,
  });
  return {
    boundary: input.boundary,
    id: input.id,
    kind: input.kind,
    content: prepared.content,
    signals: prepared.signals,
    truncated: prepared.truncated,
  };
}

export function formatUntrustedBlock(block: UntrustedBlock): string {
  return [
    `<<${block.boundary} id="${block.id}" kind="${block.kind}">>`,
    block.content,
    `<<END_${block.boundary}>>`,
  ].join('\n');
}

export function isInjectionSuspect(signals: readonly InjectionSignal[]): boolean {
  return signals.some((signal) => signal.severity === 'high');
}

export function summarizeInjectionSignals(signals: readonly InjectionSignal[]): string {
  if (signals.length === 0) {
    return 'no injection signals';
  }
  const counts = new Map<InjectionSignalKind, number>();
  for (const signal of signals) {
    counts.set(signal.kind, (counts.get(signal.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => `${kind}x${count}`).join(', ');
}
