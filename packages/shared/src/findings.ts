import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isSafeRelativePath, normalizeRepoPath } from './paths';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'bug',
  'security',
  'performance',
  'architecture',
  'maintainability',
  'testing',
  'style',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const FINDING_STATUSES = [
  'draft',
  'validated',
  'published',
  'dismissed',
  'resolved',
  'stale',
  'suppressed',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_SOURCES = ['agent', 'static_analysis', 'security_scan', 'test_execution', 'human'] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export type ConfidenceBand = 'low' | 'medium' | 'high';

export const FindingDraftSchema = z.object({
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  title: z.string().min(4).max(200),
  description: z.string().min(10).max(6000),
  file: z.string().min(1).max(1024),
  line: z.number().int().min(1).max(2_000_000).nullable().default(null),
  endLine: z.number().int().min(1).max(2_000_000).nullable().default(null),
  suggestion: z.string().max(6000).nullable().default(null),
  confidence: z.number().min(0).max(1),
  evidence: z.string().max(8000).nullable().default(null),
  source: z.enum(FINDING_SOURCES).default('agent'),
  ruleId: z.string().max(160).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
});

export type FindingDraft = z.infer<typeof FindingDraftSchema>;

export interface ValidationPolicy {
  readonly minPublishConfidence: number;
  readonly minKeepConfidence?: number;
  readonly allowedFiles?: readonly string[];
  readonly requireEvidenceForSeverities?: readonly Severity[];
  readonly severityDowngradeConfidence?: number;
}

export interface FindingValidationOutcome {
  readonly decision: 'keep' | 'discard';
  readonly publishable: boolean;
  readonly reasons: readonly string[];
  readonly fingerprint: string;
  readonly confidenceBand: ConfidenceBand;
  readonly finding: FindingDraft;
}

export interface PriorFindingReference {
  readonly fingerprint: string;
  readonly status: FindingStatus;
  readonly severity: Severity;
}

const GENERIC_TITLE_PATTERNS: readonly string[] = [
  'looks good',
  'consider refactoring',
  'could be improved',
  'follow best practices',
  'needs more tests',
  'no issues found',
  'maybe you should',
  'it is recommended',
  'code smell',
  'generally speaking',
  'improve readability',
  'add tests',
  'missing documentation',
];

const GENERIC_BODY_PATTERNS: readonly RegExp[] = [
  /\bconsider (?:refactoring|improving|adding)\b/i,
  /\bfollow (?:the )?best practices?\b/i,
  /\bmaintainability could be improved\b/i,
  /\bthis (?:could|might) be (?:a )?(?:problem|issue)\b/i,
  /\bmake sure to (?:test|add tests)\b/i,
];

const CONCRETE_REFERENCE_PATTERN =
  /`[^`\n]{2,}`|'[^'\n]{3,}'|"\S{3,}"|:\d+|\bline\s+\d+|\b[a-zA-Z_$][\w$]*\s*\(|\b[a-z]+[A-Z]\w*\b|\.[a-z]{1,5}\b|\[[^\]]+\]/;

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.8) {
    return 'high';
  }
  if (confidence >= 0.6) {
    return 'medium';
  }
  return 'low';
}

export function normalizeFindingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'*_]/g, '')
    .replace(/[^a-z0-9\s/.:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fingerprints are intentionally line-bucketed (10-line groups) so the same
 * defect is recognised as identical after unrelated lines shift the diff.
 */
export function findingFingerprint(
  finding: Pick<FindingDraft, 'category' | 'file' | 'title' | 'line'>,
): string {
  const lineBucket = finding.line === null ? 'na' : String(Math.floor((finding.line - 1) / 10));
  const payload = [
    finding.category,
    normalizeRepoPath(finding.file).toLowerCase(),
    normalizeFindingText(finding.title),
    lineBucket,
  ].join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}

export function isGenericObservation(title: string, description: string): boolean {
  const normalizedTitle = normalizeFindingText(title);
  const combined = `${title}\n${description}`;
  const normalizedBody = normalizeFindingText(description);

  if (GENERIC_TITLE_PATTERNS.some((pattern) => normalizedTitle === pattern)) {
    return true;
  }
  const genericHits = GENERIC_BODY_PATTERNS.filter((pattern) => pattern.test(combined)).length;
  if (genericHits === 0) {
    return false;
  }
  const hasConcreteReference = CONCRETE_REFERENCE_PATTERN.test(combined);
  if (hasConcreteReference) {
    return false;
  }
  return normalizedBody.length < 240 || genericHits >= 2;
}

export function calibrateSeverity(severity: Severity, confidence: number, threshold: number): Severity {
  if (confidence >= threshold) {
    return severity;
  }
  if (severity === 'critical') {
    return 'high';
  }
  if (severity === 'high') {
    return 'medium';
  }
  return severity;
}

export function validateFinding(
  draft: FindingDraft,
  policy: ValidationPolicy,
): FindingValidationOutcome {
  const reasons: string[] = [];
  let decision: 'keep' | 'discard' = 'keep';
  const minKeepConfidence = policy.minKeepConfidence ?? 0.4;
  const downgradeThreshold = policy.severityDowngradeConfidence ?? 0.7;
  const evidenceSeverities = policy.requireEvidenceForSeverities ?? ['critical'];
  let finding = { ...draft };

  finding.file = normalizeRepoPath(finding.file);

  if (!isSafeRelativePath(finding.file)) {
    return {
      decision: 'discard',
      publishable: false,
      reasons: ['unsafe_file_path'],
      fingerprint: findingFingerprint(finding),
      confidenceBand: confidenceBand(finding.confidence),
      finding,
    };
  }

  if (finding.confidence < minKeepConfidence) {
    decision = 'discard';
    reasons.push('confidence_below_keep_threshold');
  }

  if (finding.line !== null && finding.endLine !== null && finding.endLine < finding.line) {
    finding.endLine = finding.line;
    reasons.push('end_line_clamped');
  }
  if (finding.line === null && finding.endLine !== null) {
    finding.line = finding.endLine;
    reasons.push('line_derived_from_end_line');
  }

  if (normalizeFindingText(finding.title).length < 8) {
    decision = 'discard';
    reasons.push('title_too_vague');
  }

  if (isGenericObservation(finding.title, finding.description)) {
    decision = 'discard';
    reasons.push('generic_observation');
  }

  const evidenceRequired = evidenceSeverities.includes(finding.severity) || finding.category === 'security';
  if (evidenceRequired && (finding.evidence === null || finding.evidence.trim().length < 8)) {
    decision = 'discard';
    reasons.push('missing_evidence');
  }

  const calibrated = calibrateSeverity(finding.severity, finding.confidence, downgradeThreshold);
  if (calibrated !== finding.severity) {
    reasons.push(`severity_calibrated:${finding.severity}->${calibrated}`);
    finding = { ...finding, severity: calibrated };
  }

  const allowedFiles = policy.allowedFiles;
  let withinScope = true;
  if (allowedFiles !== undefined && allowedFiles.length > 0) {
    const allowed = new Set(allowedFiles.map((file) => normalizeRepoPath(file).toLowerCase()));
    withinScope = allowed.has(finding.file.toLowerCase());
    if (!withinScope) {
      reasons.push('outside_changed_files');
    }
  }

  const publishable =
    decision === 'keep' && withinScope && finding.confidence >= policy.minPublishConfidence;

  if (publishable && reasons.length === 0) {
    reasons.push('validated');
  }

  return {
    decision,
    publishable,
    reasons,
    fingerprint: findingFingerprint(finding),
    confidenceBand: confidenceBand(finding.confidence),
    finding,
  };
}

export interface DedupeResult {
  readonly unique: readonly FindingDraft[];
  readonly duplicates: readonly { readonly finding: FindingDraft; readonly duplicateOfFingerprint: string }[];
}

function compareFindings(left: FindingDraft, right: FindingDraft): number {
  const severityDelta = SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }
  return right.confidence - left.confidence;
}

export function dedupeFindings(findings: readonly FindingDraft[]): DedupeResult {
  const byFingerprint = new Map<string, FindingDraft[]>();
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding);
    const bucket = byFingerprint.get(fingerprint);
    if (bucket === undefined) {
      byFingerprint.set(fingerprint, [finding]);
    } else {
      bucket.push(finding);
    }
  }

  const unique: FindingDraft[] = [];
  const duplicates: { finding: FindingDraft; duplicateOfFingerprint: string }[] = [];
  for (const [fingerprint, bucket] of byFingerprint) {
    const sorted = [...bucket].sort(compareFindings);
    const [primary, ...rest] = sorted;
    if (primary === undefined) {
      continue;
    }
    unique.push(primary);
    for (const duplicate of rest) {
      duplicates.push({ finding: duplicate, duplicateOfFingerprint: fingerprint });
    }
  }
  return { unique, duplicates };
}

export interface PriorFindingComparison {
  readonly fresh: readonly FindingDraft[];
  readonly previouslyReported: readonly FindingDraft[];
  readonly previouslyDismissed: readonly FindingDraft[];
}

export function compareWithPreviousFindings(
  findings: readonly FindingDraft[],
  previous: readonly PriorFindingReference[],
): PriorFindingComparison {
  const previousByFingerprint = new Map(previous.map((entry) => [entry.fingerprint, entry]));
  const fresh: FindingDraft[] = [];
  const previouslyReported: FindingDraft[] = [];
  const previouslyDismissed: FindingDraft[] = [];

  for (const finding of findings) {
    const match = previousByFingerprint.get(findingFingerprint(finding));
    if (match === undefined) {
      fresh.push(finding);
      continue;
    }
    if (match.status === 'dismissed' || match.status === 'suppressed' || match.status === 'resolved') {
      previouslyDismissed.push(finding);
      continue;
    }
    previouslyReported.push(finding);
  }

  return { fresh, previouslyReported, previouslyDismissed };
}

export interface FindingSummary {
  readonly total: number;
  readonly publishable: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly byCategory: Readonly<Record<Category, number>>;
  readonly highestSeverity: Severity | null;
}

export function summarizeFindings(
  findings: readonly (FindingDraft & { publishable?: boolean })[],
): FindingSummary {
  const bySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  const byCategory: Record<Category, number> = {
    bug: 0,
    security: 0,
    performance: 0,
    architecture: 0,
    maintainability: 0,
    testing: 0,
    style: 0,
  };

  let publishable = 0;
  let highestSeverity: Severity | null = null;
  let highestWeight = 0;

  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byCategory[finding.category] += 1;
    if (finding.publishable !== false) {
      publishable += 1;
    }
    const weight = SEVERITY_WEIGHT[finding.severity];
    if (weight > highestWeight) {
      highestWeight = weight;
      highestSeverity = finding.severity;
    }
  }

  return {
    total: findings.length,
    publishable,
    bySeverity,
    byCategory,
    highestSeverity,
  };
}

export function formatFindingSummary(summary: FindingSummary): string {
  const parts: string[] = [];
  for (const severity of SEVERITIES) {
    const count = summary.bySeverity[severity];
    if (count > 0) {
      parts.push(`${count} ${severity}`);
    }
  }
  return parts.length === 0 ? 'no findings' : parts.join(', ');
}
