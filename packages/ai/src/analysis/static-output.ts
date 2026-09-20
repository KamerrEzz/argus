import { FindingDraftSchema, normalizeRepoPath, stripAnsi } from '@acr/shared';
import type { CommandKind, FindingDraft, Severity } from '@acr/shared';

export interface ParseInput {
  readonly kind: CommandKind;
  readonly tool: string;
  readonly stdout: string;
  readonly stderr: string;
  /** Absolute workspace directory, stripped from reported paths. */
  readonly workspaceDir: string;
  readonly maxFindings?: number;
}

const TSC_PATTERN = /^(?<file>[^\s(]+)\((?<line>\d+),\d+\):\s+(?<level>error|warning)\s+(?<rule>[A-Z]+\d+):\s+(?<message>.+)$/;
const GENERIC_PATTERN = /^(?<file>[^\s:]+):(?<line>\d+)(?::\d+)?(?::\d+)?[:\s]+(?:(?<level>error|warning)\s+)?(?:\[(?<rule>[^\]]+)\]\s*)?(?<message>.+)$/;

/**
 * Turn machine-readable check output into findings. Only formats we actually
 * recognise produce findings; anything else leaves the command outcome as the
 * evidence, so a parser never invents problems from noise.
 */
export function parseCheckOutput(input: ParseInput): readonly FindingDraft[] {
  const limit = input.maxFindings ?? 40;
  const output: FindingDraft[] = [];

  const push = (candidate: {
    file: string;
    line: number | null;
    severity: Severity;
    ruleId: string | null;
    title: string;
    description: string;
    confidence: number;
  }): void => {
    if (output.length >= limit) {
      return;
    }
    const file = normalizeReportedPath(candidate.file, input.workspaceDir);
    if (file === null) {
      return;
    }
    const parsed = FindingDraftSchema.safeParse({
      severity: candidate.severity,
      category: categoryFor(input.kind),
      title: clip(candidate.title, 200),
      description: clip(candidate.description, 6000),
      file,
      line: candidate.line,
      endLine: null,
      suggestion: null,
      confidence: candidate.confidence,
      evidence: `${input.tool} reported: ${clip(candidate.description, 500)}`,
      source: sourceFor(input.kind),
      ruleId: candidate.ruleId,
      metadata: { tool: input.tool, kind: input.kind },
    });
    if (parsed.success) {
      output.push(parsed.data);
    }
  };

  for (const eslint of readEslintJson(input.stdout)) {
    push(eslint);
  }
  for (const line of textLines(input)) {
    const tsc = TSC_PATTERN.exec(line);
    if (tsc?.groups !== undefined) {
      push({
        file: tsc.groups['file'] ?? '',
        line: numberOr(tsc.groups['line'], null),
        severity: tsc.groups['level'] === 'warning' ? 'low' : 'medium',
        ruleId: tsc.groups['rule'] ?? null,
        title: `${tsc.groups['rule'] ?? 'type error'}: ${firstSentence(tsc.groups['message'] ?? '')}`,
        description: `${input.tool}: ${tsc.groups['message'] ?? ''}`,
        confidence: 0.95,
      });
      continue;
    }
    const generic = GENERIC_PATTERN.exec(line);
    const genericFile = generic?.groups?.['file'] ?? '';
    if (generic?.groups !== undefined && looksLikeRepoPath(genericFile.replace(/\\/g, '/'))) {
      push({
        file: generic.groups['file'] ?? '',
        line: numberOr(generic.groups['line'], null),
        severity: generic.groups['level'] === 'warning' ? 'low' : 'medium',
        ruleId: generic.groups['rule'] ?? null,
        title: `${generic.groups['rule'] ?? input.tool}: ${firstSentence(generic.groups['message'] ?? '')}`,
        description: `${input.tool}: ${generic.groups['message'] ?? ''}`,
        confidence: 0.9,
      });
    }
  }

  return dedupeByLocation(output);
}

function* readEslintJson(stdout: string): Generator<{
  file: string;
  line: number | null;
  severity: Severity;
  ruleId: string | null;
  title: string;
  description: string;
  confidence: number;
}> {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown;
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) {
    return;
  }
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as { filePath?: unknown; messages?: unknown };
    if (typeof record.filePath !== 'string' || !Array.isArray(record.messages)) {
      continue;
    }
    for (const message of record.messages as EslintMessage[]) {
      if (typeof message?.message !== 'string') {
        continue;
      }
      yield {
        file: record.filePath,
        line: typeof message.line === 'number' ? message.line : null,
        severity: message.severity === 2 ? 'medium' : 'low',
        ruleId: typeof message.ruleId === 'string' ? message.ruleId : null,
        title: `${message.ruleId ?? 'lint error'}: ${firstSentence(message.message)}`,
        description: `ESLint reported ${message.ruleId ?? 'an error'}: ${message.message}`,
        confidence: 0.95,
      };
    }
  }
}

interface EslintMessage {
  readonly ruleId?: string | null;
  readonly severity?: number;
  readonly line?: number;
  readonly message?: string;
}

function textLines(input: ParseInput): string[] {
  const lines: string[] = [];
  for (const stream of [input.stdout, input.stderr]) {
    // Colour codes must never hide a real error line: strip ANSI first, then trim.
    for (const line of stripAnsi(stream).split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length < 500) {
        lines.push(trimmed);
      }
    }
  }
  return lines;
}

function normalizeReportedPath(file: string, workspaceDir: string): string | null {
  const withoutPrefix = file
    // Windows separators first: `.\src\a.ts` must normalise like `./src/a.ts`.
    .replace(/\\/g, '/')
    .replace(new RegExp(`^${escapeRegExp(workspaceDir.replace(/\\/g, '/'))}[/]?`), '')
    .replace(/^[A-Za-z]:[/]/, '')
    .replace(/^\.\//, '');
  if (withoutPrefix.length === 0 || !looksLikeRepoPath(withoutPrefix)) {
    return null;
  }
  try {
    return normalizeRepoPath(withoutPrefix);
  } catch {
    return null;
  }
}

function looksLikeRepoPath(value: string): boolean {
  return /^[A-Za-z0-9_.\-/@ ]+(\/[A-Za-z0-9_.\-@ ]+)*\.[A-Za-z0-9]+$/.test(value) || /^[A-Za-z0-9_.\-/@ ]+\/$/.test(value);
}

function categoryFor(kind: CommandKind): 'bug' | 'style' | 'security' {
  switch (kind) {
    case 'security_scan':
      return 'security';
    case 'lint':
      return 'style';
    default:
      return 'bug';
  }
}

function sourceFor(kind: CommandKind): 'static_analysis' | 'security_scan' | 'test_execution' {
  if (kind === 'security_scan') {
    return 'security_scan';
  }
  if (kind === 'test') {
    return 'test_execution';
  }
  return 'static_analysis';
}

function dedupeByLocation(findings: readonly FindingDraft[]): readonly FindingDraft[] {
  const seen = new Set<string>();
  const output: FindingDraft[] = [];
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line ?? 0}:${finding.ruleId ?? ''}:${finding.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(finding);
  }
  return output;
}

function firstSentence(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  const stop = cleaned.search(/[.!?](\s|$)/);
  return stop > 0 ? cleaned.slice(0, stop) : cleaned;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function numberOr(value: string | undefined, fallback: number | null): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
