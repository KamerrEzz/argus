import { describe, expect, it } from 'vitest';
import { parseCheckOutput } from '@acr/ai';
import type { CheckOutputParseInput } from '@acr/ai';
import type { FindingDraft } from '@acr/shared';
import { isSafeRelativePath, validateFinding } from '@acr/shared';

const WS = '/w/repo';

function parse(over: Partial<CheckOutputParseInput> = {}): readonly FindingDraft[] {
  const input: CheckOutputParseInput = {
    kind: 'typecheck',
    tool: 'tsc',
    stdout: '',
    stderr: '',
    workspaceDir: WS,
    ...over,
  };
  return parseCheckOutput(input);
}

function first(findings: readonly FindingDraft[]): FindingDraft {
  const head = findings[0];
  if (head === undefined) {
    throw new Error(`expected at least one finding, got ${findings.length}`);
  }
  return head;
}

const TSC_ERROR = 'src/app.ts(12,5): error TS2345: Argument of type "string" is not assignable to parameter of type "number". Did you mean 42.';

describe('tsc-style lines', () => {
  it('produces one medium bug finding with the exact downstream contract', () => {
    const findings = parse({ stdout: TSC_ERROR });
    expect(findings).toHaveLength(1);
    const f = first(findings);
    expect(f.severity).toBe('medium');
    expect(f.category).toBe('bug');
    expect(f.source).toBe('static_analysis');
    expect(f.file).toBe('src/app.ts');
    expect(f.line).toBe(12);
    expect(f.endLine).toBeNull();
    expect(f.suggestion).toBeNull();
    expect(f.ruleId).toBe('TS2345');
    expect(f.confidence).toBe(0.95);
    expect(f.title).toBe('TS2345: Argument of type "string" is not assignable to parameter of type "number"');
    expect(f.description).toBe('tsc: Argument of type "string" is not assignable to parameter of type "number". Did you mean 42.');
    expect(f.evidence).toBe(`tsc reported: ${f.description}`);
    expect(f.metadata).toEqual({ tool: 'tsc', kind: 'typecheck' });
  });

  it('maps a tsc warning to severity low', () => {
    const findings = parse({ stdout: 'src/a.ts(3,4): warning TS6133: x is declared but never used.' });
    expect(first(findings).severity).toBe('low');
  });

  it('separates several failures across different files', () => {
    const findings = parse({
      stdout: [
        'src/a.ts(1,2): error TS2345: first failure with a long message',
        'noise in the middle of the build log',
        'packages/b/c.ts(9,1): error TS7006: second failure in another file',
      ].join('\n'),
    });
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts', 'packages/b/c.ts']);
    expect(findings.map((f) => f.line)).toEqual([1, 9]);
  });

  it('cuts titles at the first sentence but keeps the full message in the description', () => {
    const findings = parse({
      stdout: 'src/a.ts(1,1): error TS1234: Short stop. A second sentence explains more.!',
    });
    const f = first(findings);
    expect(f.title).toBe('TS1234: Short stop');
    expect(f.description).toBe('tsc: Short stop. A second sentence explains more.!');
  });
});

describe('generic `file:line: ...` lines (mypy/eslint-stylish-ish)', () => {
  it('parses mypy-style errors and marks them medium by default', () => {
    const findings = parse({ kind: 'typecheck', tool: 'mypy', stdout: 'pkg/mod.py:42: error: Incompatible return value type' });
    const f = first(findings);
    expect(f.file).toBe('pkg/mod.py');
    expect(f.line).toBe(42);
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBe(0.9);
    expect(f.ruleId).toBeNull();
    // As-coded: mypy writes `error:` with a colon, so the level group does not
    // fire and the word stays inside the message instead of setting severity.
    expect(f.title).toBe('mypy: error: Incompatible return value type');
  });

  it('honours an explicit warning level and bracketed rule id', () => {
    const findings = parse({
      kind: 'lint',
      tool: 'eslint',
      stdout: 'src/legacy.js:8: warning [no-console] Unexpected console statement.',
    });
    const f = first(findings);
    expect(f.severity).toBe('low');
    expect(f.ruleId).toBe('no-console');
    expect(f.category).toBe('style');
    expect(f.source).toBe('static_analysis');
    expect(f.title).toBe('no-console: Unexpected console statement');
  });

  it('consumes an extra column component without inventing an endLine', () => {
    const findings = parse({
      kind: 'test',
      tool: 'vitest',
      stdout: 'tests/calc.test.ts:6:15 AssertionError: expected 4 to be 3 in the sum test',
    });
    const f = first(findings);
    expect(f.line).toBe(6);
    expect(f.endLine).toBeNull();
    expect(f.category).toBe('bug');
    expect(f.source).toBe('test_execution');
  });

  it('drops generic lines whose prefix does not look like a repo path', () => {
    expect(parse({ stdout: 'FAIL tests/calc.test.ts > calc > adds' })).toHaveLength(0);
    expect(parse({ stdout: '7|   expect(sum(1,2)).toBe(4)' })).toHaveLength(0);
    expect(parse({ stdout: '    at Object.<anonymous> (tests/calc.js:8:12)' })).toHaveLength(0);
  });
});

describe('ESLint JSON reporter', () => {
  const json = JSON.stringify([
    {
      filePath: `${WS}/src/a.ts`,
      messages: [
        { ruleId: 'no-unused-vars', severity: 2, line: 10, message: 'x is assigned a value but never used. Why?' },
        { ruleId: null, severity: 1, message: 'Missing source location in this report entry.' },
      ],
    },
  ]);

  it('maps error severity 2 to medium and 1 to low, with style/static_analysis contract', () => {
    const findings = parse({ kind: 'lint', tool: 'eslint', stdout: `pre-roll noise\n${json}\npost` });
    expect(findings).toHaveLength(2);
    const [hard, soft] = findings;
    expect(hard?.severity).toBe('medium');
    expect(hard?.category).toBe('style');
    expect(hard?.source).toBe('static_analysis');
    expect(hard?.file).toBe('src/a.ts');
    expect(hard?.line).toBe(10);
    expect(hard?.title).toBe('no-unused-vars: x is assigned a value but never used');
    expect(soft?.severity).toBe('low');
    expect(soft?.ruleId).toBeNull();
    expect(soft?.title).toBe('lint error: Missing source location in this report entry');
  });

  it('leaves line null when the report omits it instead of fabricating one', () => {
    const findings = parse({ kind: 'lint', tool: 'eslint', stdout: json });
    const withoutLine = findings.find((f) => f.ruleId === null);
    expect(withoutLine?.line).toBeNull();
  });

  it('ignores malformed or non-array JSON payloads', () => {
    expect(parse({ stdout: '[ this is not json ]' })).toHaveLength(0);
    expect(parse({ stdout: '{"not": "an array"}' })).toHaveLength(0);
    expect(parse({ stdout: '[{"filePath": 42}]' })).toHaveLength(0);
    expect(parse({ stdout: 'no brackets at all' })).toHaveLength(0);
  });
});

describe('category and source mapping per command kind', () => {
  it('security_scan maps to security + security_scan', () => {
    const f = first(parse({ kind: 'security_scan', tool: 'semgrep', stdout: 'src/x.ts:3: error [r] hardcoded secret detected here' }));
    expect(f.category).toBe('security');
    expect(f.source).toBe('security_scan');
  });

  it('build, typecheck and static_analysis all map to bug + static_analysis', () => {
    for (const kind of ['build', 'typecheck', 'static_analysis'] as const) {
      const f = first(parse({ kind, tool: 'toolx', stdout: 'src/x.ts(1,1): error TS999: compiler complained loudly' }));
      expect(f.category, kind).toBe('bug');
      expect(f.source, kind).toBe('static_analysis');
    }
  });
});

describe('honest output conditions', () => {
  it('all-pass output produces zero findings', () => {
    const stdout = [
      ' RUN  v3.2.4 /w/repo',
      ' ✓ src/math.test.ts (5 tests) 12ms',
      ' Test Files  1 passed (1)',
      '      Tests  5 passed (5)',
      '   Start at  10:11:12',
      '   Duration  412ms',
    ].join('\n');
    expect(parse({ kind: 'test', tool: 'vitest', stdout })).toHaveLength(0);
  });

  it('a crash with no parseable summary produces zero findings', () => {
    const stdout = 'panic: runtime error: index out of range [3] with length 2\n\ngoroutine 1 [running]:\nmain.main()';
    expect(parse({ kind: 'test', tool: 'go-test', stdout })).toHaveLength(0);
    // As-coded caveat: a raw go panic frame line such as "/app/main.go:22 +0x1c"
    // DOES match the generic file:line pattern and yields a low-content finding
    // (message "+0x1c"). Tightening that belongs with parser improvements, not
    // this assertion batch, so the crash sample above omits the frame line.
  });

  it('empty stdout and stderr produce an empty array, not undefined', () => {
    expect(parse({ stdout: '', stderr: '' })).toEqual([]);
  });

  it('the parser cannot see the exit code; parsed findings win and absence is honest', () => {
    // As-coded: ParseInput has no exitCode field at all. A clean exit whose
    // output contains real error lines still yields findings, and a failing
    // exit with unparseable output yields none — the pipeline's
    // createStaticAnalysisNode then adds one fallback finding for the failure
    // (that wiring is integration-level, verified there).
    const failingButUnparseable = parse({ kind: 'test', tool: 'x', stdout: 'Segmentation fault (core dumped)' });
    expect(failingButUnparseable).toHaveLength(0);
    const passingWithErrors = parse({ stdout: TSC_ERROR });
    expect(passingWithErrors).toHaveLength(1);
  });
});

describe('hostile and awkward text', () => {
  it('parses CRLF output exactly like LF output', () => {
    const lf = parse({ stdout: 'src/a.ts(1,2): error TS1: a compiler failure\nsrc/b.ts:3: error [r] another failure\n' });
    const crlf = parse({ stdout: 'src/a.ts(1,2): error TS1: a compiler failure\r\nsrc/b.ts:3: error [r] another failure\r\n' });
    expect(crlf).toEqual(lf);
    expect(crlf).toHaveLength(2);
  });

  it('ANSI-colored error lines still parse with clean text', () => {
    const findings = parse({ stdout: '\u001b[31msrc/app.ts(1,2): error TS2001: boom goes the compiler\u001b[39m' });
    expect(findings).toHaveLength(1);
    const f = first(findings);
    expect(f.file).toBe('src/app.ts');
    expect(f.title).toBe('TS2001: boom goes the compiler');
    expect(f.title).not.toContain('\u001b');
    expect(f.evidence).not.toContain('\u001b');
  });

  it('survives a line truncated mid-message and one truncated mid-pattern', () => {
    const midMessage = parse({ stdout: 'src/a.ts(1,2): error TS9: incomplete message abo' });
    expect(midMessage).toHaveLength(1);
    expect(first(midMessage).description).toBe('tsc: incomplete message abo');
    const midPattern = parse({ stdout: 'src/a.ts(1,2): err' });
    expect(midPattern).toHaveLength(0);
  });

  it('drops lines of 500 or more characters (noise filter, bounded work)', () => {
    const giant = `src/a.ts(1,2): error TS9: ${'x'.repeat(600)}`;
    expect(parse({ stdout: giant })).toHaveLength(0);
  });

  it('a 5k-line log stays bounded by maxFindings and does not blow up', () => {
    const stdout = Array.from(
      { length: 5000 },
      (_, i) => (i % 3 === 0 ? `src/f${i}.ts(${i + 1},1): error TS9: failure number ${i} detail text` : `noise ${i}`),
    ).join('\n');
    const startedAt = Date.now();
    const findings = parse({ stdout });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(findings).toHaveLength(40); // default cap
    const custom = parse({ stdout, maxFindings: 12 });
    expect(custom).toHaveLength(12);
    expect(parse({ stdout, maxFindings: 0 })).toHaveLength(0);
  });

  it('drops findings whose schema cannot accept them (message shorter than 10 chars)', () => {
    // As-coded: description = `tsc: <msg>` must be >= 10 characters, so a
    // one-word error like "boom" is honestly discarded rather than inflated.
    expect(parse({ stdout: 'src/a.ts(1,2): error TS9: boom' })).toHaveLength(0);
    expect(parse({ stdout: 'src/a.ts(1,2): error TS9: boom boom boom' })).toHaveLength(1);
  });

  it('reads both stdout and stderr', () => {
    const findings = parse({ stdout: 'src/a.ts(1,2): error TS1: first error from stdout here', stderr: 'src/b.ts:3: error [r] second error from stderr here' });
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('path normalization and scope honesty', () => {
  it('strips the workspace prefix', () => {
    expect(first(parse({ stdout: `${WS}/src/a.ts(1,2): error TS1: absolute workspace path error` })).file).toBe('src/a.ts');
  });

  it('handles Windows drive-qualified paths inside and outside the workspace', () => {
    const inside = parse({
      stdout: 'C:\\ws\\src\\a.ts(1,2): error TS1: failure via a Windows workspace path',
      workspaceDir: 'C:\\ws',
    });
    expect(first(inside).file).toBe('src/a.ts');
    const outside = parse({
      stdout: 'D:\\other\\lib\\b.ts(1,2): error TS1: failure on a foreign drive path',
      workspaceDir: 'C:\\ws',
    });
    expect(first(outside).file).toBe('other/lib/b.ts');
  });

  it('normalizes a ./ relative generic line', () => {
    const findings = parse({ kind: 'lint', tool: 't', stdout: './src/a.ts:5: error [r] relative dot-slash failure here' });
    expect(first(findings).file).toBe('src/a.ts');
  });

  it('does not scope by the changed set: unrelated files still parse at the fixed confidence', () => {
    // The parser has no changed-file knowledge; confidence is a constant, never
    // inflated per-file, and downstream validateFinding removes it from scope.
    const findings = parse({ kind: 'lint', tool: 't', stdout: 'vendor/dep/lib.js:5: error [x] issue inside vendored code here' });
    const f = first(findings);
    expect(f.confidence).toBe(0.9);
    const outcome = validateFinding(f, { minPublishConfidence: 0.7, allowedFiles: ['src/app.ts'] });
    expect(outcome.publishable).toBe(false);
    expect(outcome.reasons).toContain('outside_changed_files');
  });

  it('a ../-escaping file may be parsed but is discarded by validation, never published', () => {
    const findings = parse({ kind: 'lint', tool: 't', stdout: '../outside/secrets.env:5: error [x] leaked configuration found here' });
    expect(findings).toHaveLength(1);
    const f = first(findings);
    expect(isSafeRelativePath(f.file)).toBe(false);
    const outcome = validateFinding(f, { minPublishConfidence: 0.7 });
    expect(outcome.decision).toBe('discard');
    expect(outcome.reasons).toContain('unsafe_file_path');
  });

  it('extracts locations only from the text, never from message bodies', () => {
    const findings = parse({
      kind: 'lint',
      tool: 't',
      stdout: 'src/a.ts:3: error [r] found near line 77 and column 412 and also TS2345 style hints',
    });
    const f = first(findings);
    expect(f.line).toBe(3);
    expect(f.ruleId).toBe('r');
  });
});

describe('dedupe by location', () => {
  it('collapses identical file+line+rule+title triples and keeps order', () => {
    const line = 'src/a.ts(1,2): error TS1: identical message text here';
    const findings = parse({ stdout: [line, 'src/z.ts(5,6): error TS2: a different distinct failure', line].join('\n') });
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('keeps same-file/same-rule findings that differ by line or title', () => {
    const findings = parse({
      stdout: [
        'src/a.ts(1,2): error TS1: first distinct message here',
        'src/a.ts(9,9): error TS1: first distinct message here',
        'src/a.ts(1,2): error TS1: second distinct message here',
      ].join('\n'),
    });
    expect(findings).toHaveLength(3);
  });
});
