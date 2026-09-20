import { describe, expect, it } from 'vitest';
import { createToolHandlers } from '@acr/ai';
import type { AgentToolContext } from '@acr/shared';

// The bug these tests guard: a hardcoded carrier API key reached the reviewer,
// was submitted, and then vanished because no component required the model to
// point at the line it read. A blocking claim now has to carry its evidence.

function handlers() {
  // submit_findings never touches the context (it only validates its arguments),
  // so an empty one is enough to exercise the rule.
  return createToolHandlers({} as unknown as AgentToolContext, {
    launchCheck: () => Promise.reject(new Error('checks are not part of this test')),
    allowedScripts: {},
    defaultCheckTimeoutMs: 1_000,
  });
}

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...over,
  };
}

describe('submit_findings — blocking findings must carry evidence', () => {
  it('rejects a critical finding that does not quote anything', async () => {
    const result = await handlers().submit_findings({
      findings: [finding({ severity: 'critical', evidence: null })],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('evidence is required');
    expect(result.findings).toEqual([]);
    expect(result.metadata).toMatchObject({ accepted: 0, rejected: 1 });
  });

  it('holds a security finding to the rule at any severity', async () => {
    const result = await handlers().submit_findings({
      findings: [finding({ severity: 'medium', category: 'security', evidence: '   ' })],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('evidence is required');
  });

  it('accepts a blocking finding that does quote the line', async () => {
    const result = await handlers().submit_findings({
      findings: [
        finding({
          severity: 'critical',
          category: 'security',
          evidence: "const CARRIER_API_KEY = 'sk_live_...' (src/shipping.js:4)",
        }),
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  it('cannot make the error disappear by dropping the blocking finding', async () => {
    const result = await handlers().submit_findings({
      findings: [finding({ evidence: 'a concrete guard is missing here' }), finding({ severity: 'critical', evidence: '' })],
    });

    // The valid finding is withheld too, so the model has to resubmit the whole
    // set with the evidence rather than quietly lose a critical.
    expect(result.isError).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.output).toContain('Resubmit every finding');
  });

  it('leaves non-blocking findings alone', async () => {
    const result = await handlers().submit_findings({
      findings: [finding({ severity: 'low', category: 'maintainability', evidence: null })],
    });

    expect(result.isError).toBe(false);
    expect(result.findings).toHaveLength(1);
  });
});
