import { describe, expect, it } from 'vitest';
import { FindingDraftSchema, validateFinding, type FindingDraft } from '@acr/shared';

// These tests pin the validation policy itself. The bug they guard against: a
// blocking finding without evidence used to be discarded outright, so a leaked
// credential vanished from the report and the pull request looked clean.

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return FindingDraftSchema.parse({
    severity: 'high',
    category: 'bug',
    title: 'Refund path double-charges on retry',
    description: 'A retried webhook re-runs the refund because no idempotency key is checked.',
    file: 'src/pay/refund.ts',
    line: 42,
    endLine: null,
    suggestion: null,
    confidence: 0.9,
    evidence: 'handleRefund(id) re-runs the loop with no dedupe guard',
    source: 'agent',
    ruleId: null,
    metadata: null,
    ...overrides,
  });
}

const POLICY = {
  minPublishConfidence: 0.6,
  allowedFiles: ['src/pay/refund.ts'],
};

describe('validateFinding — evidence discipline', () => {
  it('keeps a critical finding without evidence, but never publishes it', () => {
    const outcome = validateFinding(draft({ severity: 'critical', evidence: null }), POLICY);

    expect(outcome.decision).toBe('keep');
    expect(outcome.publishable).toBe(false);
    expect(outcome.reasons).toContain('missing_evidence');
  });

  it('holds a security finding to the same evidence rule at any severity', () => {
    const outcome = validateFinding(
      draft({ severity: 'medium', category: 'security', evidence: undefined }),
      POLICY,
    );

    expect(outcome.decision).toBe('keep');
    expect(outcome.publishable).toBe(false);
    expect(outcome.reasons).toContain('missing_evidence');
  });

  it('treats whitespace-only evidence as no evidence', () => {
    const outcome = validateFinding(draft({ severity: 'critical', evidence: '        ' }), POLICY);

    expect(outcome.publishable).toBe(false);
    expect(outcome.reasons).toContain('missing_evidence');
  });

  it('publishes a critical finding that does carry evidence', () => {
    const outcome = validateFinding(draft({ severity: 'critical' }), POLICY);

    expect(outcome.decision).toBe('keep');
    expect(outcome.publishable).toBe(true);
    expect(outcome.reasons).not.toContain('missing_evidence');
  });
});

describe('validateFinding — the other gates still discard', () => {
  it('discards a finding below the keep threshold', () => {
    const outcome = validateFinding(draft({ confidence: 0.2 }), POLICY);

    expect(outcome.decision).toBe('discard');
    expect(outcome.publishable).toBe(false);
    expect(outcome.reasons).toContain('confidence_below_keep_threshold');
  });

  it('discards a title too vague to act on', () => {
    const outcome = validateFinding(draft({ title: 'risk' }), POLICY);

    expect(outcome.decision).toBe('discard');
    expect(outcome.reasons).toContain('title_too_vague');
  });

  it('keeps a finding outside the diff but refuses to publish it', () => {
    const outcome = validateFinding(draft({ file: 'src/other/thing.ts' }), POLICY);

    expect(outcome.decision).toBe('keep');
    expect(outcome.publishable).toBe(false);
    expect(outcome.reasons).toContain('outside_changed_files');
  });
});
