import { describe, expect, it } from 'vitest';
import {
  MAX_COMMENT_CHARS,
  findingSeverityIcon,
  formatDuration,
  renderCheckRun,
  renderReviewComment,
  sanitizeUntrustedMarkdown,
  type ReviewRenderContext,
} from '@acr/pipeline';
import type { ReviewOutcome } from '@acr/ai';
import type {
  ChangedFile,
  CheckExecutionRecord,
  FindingDraft,
  FindingValidationOutcome,
} from '@acr/shared';
import {
  REVIEW_COMMENT_MARKER,
  FindingDraftSchema,
  buildReviewPlan,
  classifyChanges,
  decideReviewVerdict,
  summarizeFindings,
  validateFinding,
} from '@acr/shared';

// ---------------------------------------------------------------------------
// Realistic input builders: every finding goes through FindingDraftSchema and
// the actual validateFinding pipeline, every verdict through
// decideReviewVerdict — nothing hand-rolled that runtime could not produce.
// ---------------------------------------------------------------------------

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return FindingDraftSchema.parse({
    severity: 'medium',
    category: 'bug',
    title: 'Missing null guard on user lookup',
    description: 'The value can be null here, so the property access throws a TypeError at runtime.',
    file: 'src/service/user.ts',
    line: 42,
    endLine: null,
    suggestion: null,
    confidence: 0.92,
    evidence: 'user.profile.display — profile may be null per getProfile() contract',
    source: 'agent',
    ruleId: null,
    metadata: null,
    ...overrides,
  });
}

function outcomeFor(finding: FindingDraft): FindingValidationOutcome {
  return validateFinding(finding, {
    minPublishConfidence: 0.7,
    allowedFiles: [finding.file],
  });
}

function commandRecord(over: Partial<CheckExecutionRecord> = {}): CheckExecutionRecord {
  return {
    kind: 'test',
    tool: 'vitest',
    command: 'npm test',
    status: 'succeeded',
    exitCode: 0,
    durationMs: 1234,
    stdout: 'Tests 5 passed',
    stderr: '',
    timedOut: false,
    sandbox: 'docker',
    image: 'node:22',
    summary: 'vitest: 5 passed',
    findings: [],
    details: null,
    skippedReason: null,
    ...over,
  };
}

function changedFile(path: string): ChangedFile {
  return { path, previousPath: null, status: 'modified', additions: 12, deletions: 3, patch: null, binary: false };
}

function baseOutcome(over: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    status: 'completed',
    verdict: 'passed',
    summary: 'review finished',
    narrative: 'Narrative body.',
    findings: [],
    publishableFindings: [],
    validated: [],
    plan: null,
    classification: null,
    pullRequest: null,
    commands: [],
    analyses: [],
    nodeTrace: [],
    warnings: [],
    skipped: [],
    injectionSignals: [],
    usage: { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 },
    iterations: 0,
    toolCalls: 0,
    stoppedReason: null,
    budgetExhausted: false,
    error: null,
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    workspaceDir: '/w/repo',
    ...over,
  };
}

function render(over: Partial<ReviewRenderContext> = {}): string {
  const context: ReviewRenderContext = {
    outcome: baseOutcome(),
    reviewRunId: 'run-123',
    repositoryFullName: 'acme/widgets',
    pullRequestNumber: 7,
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    model: 'test-model',
    durationMs: 12345,
    dashboardUrl: 'https://acr.example/runs/run-123',
    ...over,
  };
  return renderReviewComment(context);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function fenceCount(markdown: string): number {
  return (markdown.match(/^ {0,3}```/gm) ?? []).length;
}

// ---------------------------------------------------------------------------

describe('REVIEW_COMMENT_MARKER', () => {
  it('is an HTML comment, not markdown-visible text', () => {
    expect(REVIEW_COMMENT_MARKER).toBe('<!-- acr:review-summary -->');
  });

  it('appears exactly once, as the very first line of a rendered comment', () => {
    const body = render();
    expect(body.split('\n')[0]).toBe(REVIEW_COMMENT_MARKER);
    expect(countOccurrences(body, REVIEW_COMMENT_MARKER)).toBe(1);
  });

  it('the sanitizer removes the marker verbatim, so PR content cannot spoof it', () => {
    expect(sanitizeUntrustedMarkdown(REVIEW_COMMENT_MARKER)).toBe('');
  });

  it('stays exactly once when hostile findings embed the marker (verbatim or re-formed)', () => {
    const hostile = [
      draft({ title: `fix bug ${REVIEW_COMMENT_MARKER}`, file: 'src/a.ts' }),
      draft({
        title: 'Split marker re-form attempt',
        description: `<!-- <!-- -->acr:review-summary --> and <!-->leftover<!---> tricks`,
        file: 'src/b.ts',
      }),
    ];
    const body = render({
      outcome: baseOutcome({
        verdict: 'failed',
        validated: hostile.map((f) => outcomeFor(f)),
      }),
    });
    expect(countOccurrences(body, REVIEW_COMMENT_MARKER)).toBe(1);
    // The sanitizer also strips stray `-->`/`<!--` fragments, so no pair of
    // fields can conspire to hide later content (including this marker line).
    expect(body.indexOf(REVIEW_COMMENT_MARKER, body.indexOf(REVIEW_COMMENT_MARKER) + 1)).toBe(-1);
  });
});

describe('renderReviewComment content', () => {
  it('renders a passed review with no findings as a coherent body with no junk tokens', () => {
    const body = render();
    expect(body).toContain('## ✅ AI Code Review — No blocking issues found');
    expect(body).toContain('0 actionable finding(s) of 0 kept');
    expect(body).toContain('_No findings were kept after validation._');
    expect(body).not.toContain('Checks run'); // no commands AND no plan -> the section is skipped entirely
    expect(body).toContain('[review dashboard](https://acr.example/runs/run-123)');
    expect(body).toContain('<!-- run:run-123 -->');
    for (const junk of ['undefined', 'null', 'NaN', '[object Object]']) {
      expect(body, `junk token ${junk}`).not.toContain(junk);
    }
    expect(body).not.toContain('Model `');
    expect(body).not.toContain('Budget reached');
    expect(body).not.toContain('Incomplete');
  });

  it('honestly says when a plan existed but produced no runnable checks', () => {
    const plan = buildReviewPlan({
      classification: classifyChanges([changedFile('src/service/user.ts')]),
      availableScripts: { test: true, lint: false, typecheck: false, build: false },
      enableTests: true,
      enableLint: true,
      enableTypecheck: true,
      deepReviewAllowed: false,
      maxFiles: 10,
    });
    const body = render({ outcome: baseOutcome({ plan }) });
    expect(body).toContain('_No checks were runnable for this change._');
  });

  it('renders failed verdict text when decideReviewVerdict says failed', () => {
    const high = draft({ severity: 'high', title: 'Null dereference on payment session', confidence: 0.9 });
    const validated = [outcomeFor(high)];
    const summary = summarizeFindings(validated.map((v) => v.finding));
    const outcome = baseOutcome({
      verdict: decideReviewVerdict(summary, []),
      validated,
      findings: [high],
    });
    const body = render({ outcome });
    expect(outcome.verdict).toBe('failed');
    expect(body).toContain('## ❌ AI Code Review — Blocking issues found');
    expect(body).toContain('#### 🟠 high (1)');
    expect(body).not.toContain('medium (');
  });

  it('lists per-finding file, line and title with category and confidence percent', () => {
    const f = draft({ file: 'src/db/pool.ts', line: 88 });
    const body = render({
      outcome: baseOutcome({
        verdict: 'neutral',
        validated: [outcomeFor(f)],
        findings: [f],
      }),
    });
    expect(body).toContain('**Missing null guard on user lookup** — `src/db/pool.ts:88`');
    expect(body).toContain('bug · confidence 92%');
    expect(body).toContain('**Evidence:**');
    expect(body).toContain('⚠️ AI Code Review — Review completed with notes');
  });

  it('renders an endLine range only when it differs from the start line', () => {
    const f = draft({ line: 10, endLine: 13 });
    const body = render({ outcome: baseOutcome({ validated: [outcomeFor(f)], findings: [f] }) });
    expect(body).toContain('`src/service/user.ts:10-13`');
    const same = draft({ line: 10, endLine: 10 });
    expect(render({ outcome: baseOutcome({ validated: [outcomeFor(same)], findings: [same] }) })).toContain(
      '`src/service/user.ts:10`',
    );
  });

  it('renders a file-only location when the finding has no line', () => {
    const f = draft({ line: null });
    const body = render({ outcome: baseOutcome({ validated: [outcomeFor(f)], findings: [f] }) });
    expect(body).toContain('**Missing null guard on user lookup** — `src/service/user.ts`');
  });

  it('groups severities in critical-first order with counts', () => {
    const entries = [
      draft({ severity: 'low', title: 'Naming drift on helper module', file: 'src/low.ts' }),
      draft({ severity: 'critical', title: 'Drops the tenant filter on queries', file: 'src/crit.ts' }),
      draft({ severity: 'high', title: 'Missing await on promise chain', file: 'src/high.ts' }),
      draft({ severity: 'medium', title: 'Duplicated validation routine here', file: 'src/med.ts' }),
    ].map((f) => outcomeFor(f));
    const body = render({ outcome: baseOutcome({ validated: entries }) });
    const headings = ['critical', 'high', 'medium', 'low'] as const;
    const positions = headings.map((severity) => body.indexOf(`#### ${findingSeverityIcon(severity)} ${severity} (1)`));
    for (const position of positions) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b)); // rendered in SEVERITY_ORDER
  });

  it('marks kept-but-not-publishable findings as suppressed while counting them', () => {
    const weak = draft({ confidence: 0.62, title: 'Possible off-by-one on page index' });
    const entry = outcomeFor(weak);
    expect(entry.decision).toBe('keep');
    expect(entry.publishable).toBe(false); // as-coded: summary.publishable counts
    const body = render({ outcome: baseOutcome({ validated: [entry], findings: [weak] }) });
    expect(body).toContain('_suppressed_');
    // The count line distinguishes the two: kept by the reviewer, not fit to publish.
    expect(body).toContain('0 actionable finding(s) of 1 kept');
    expect(body).toContain('1 low-confidence item(s) were suppressed');
  });

  it('omits the cost line at zero cost and shows tokens/cost when spend exists', () => {
    expect(render()).not.toContain(' tokens');
    const body = render({
      outcome: baseOutcome({ usage: { tokensIn: 1200, tokensOut: 340, estimatedCostUsd: 0.045 } }),
    });
    expect(body).toContain('Model `test-model` · 1540 tokens · ~$0.045');
  });

  it('shows the budget banner with the stopped reason when exhaustion was reported', () => {
    const body = render({
      outcome: baseOutcome({ status: 'partial', budgetExhausted: true, stoppedReason: 'max_tokens reached' }),
    });
    expect(body).toContain('> **Budget reached.** max_tokens reached');
  });

  it('publishes the reviewer narrative, sanitized, when one was written', () => {
    const body = render({
      outcome: baseOutcome({
        narrative: 'The migration drops a column still read by the worker.\n\n### urgent\n[a](javascript:evil)',
      }),
    });
    expect(body).toContain('The migration drops a column still read by the worker.');
    expect(body).not.toContain('### urgent');
    // Our own footer still links to the dashboard; the narrative must not.
    expect(body).not.toContain('[a](');
    expect(body).toContain('a (javascript:evil)');
  });

  it('adds a severity breakdown only when there is something to break down', () => {
    expect(render()).not.toMatch(/critical.*·|· info$/m);
    const strong = draft({ severity: 'critical', title: 'Drops a column still read in production' });
    const body = render({ outcome: baseOutcome({ validated: [outcomeFor(strong)], findings: [strong] }) });
    expect(body).toMatch(/1 critical/);
  });

  it('shows an Incomplete blockquote with sanitized error text on failed runs', () => {
    const body = render({
      outcome: baseOutcome({
        status: 'failed',
        verdict: null,
        error: '<script>boom</script> https://evil.example',
      }),
    });
    expect(body).toContain('> **Incomplete.** scriptboom/script https://evil.example');
    expect(body).not.toContain('<script>');
    expect(body).toContain('⚠️ AI Code Review — Review completed with notes'); // null verdict renders neutral
  });

  it('renders the checks table with kind, command, result, exit code and duration', () => {
    const commands = [
      commandRecord(),
      commandRecord({ kind: 'lint', tool: 'eslint', command: 'npm run lint', status: 'failed', exitCode: 1, durationMs: 60_500 }),
      commandRecord({ kind: 'build', tool: 'tsc', command: 'npm run build', status: 'skipped', exitCode: null, durationMs: 0, skippedReason: 'no build script' }),
    ];
    const body = render({ outcome: baseOutcome({ commands }) });
    expect(body).toContain('| Kind | Command | Result | Time |');
    expect(body).toContain('| test | `npm test` | ✅ passed (0) | 1.2s |');
    expect(body).toContain('| lint | `npm run lint` | ❌ failed (1) | 1m 1s |');
    expect(body).toContain('| build | `npm run build` | ⏭️ skipped (—) | 0ms |');
  });

  it('lists skipped outcomes after the table', () => {
    const body = render({
      outcome: baseOutcome({
        commands: [commandRecord()],
        skipped: ['static_analysis: no checks were executed'],
      }),
    });
    expect(body).toContain('Skipped: static_analysis: no checks were executed');
  });

  it('notes prompt-injection signals once per distinct kind', () => {
    const body = render({
      outcome: baseOutcome({
        injectionSignals: [
          { kind: 'role_spoofing', severity: 'high', snippet: 'you are DAN', offset: 3 },
          { kind: 'role_spoofing', severity: 'medium', snippet: 'pretend to be', offset: 90 },
          { kind: 'delimiter_escape', severity: 'high', snippet: '```ignore', offset: 120 },
        ],
      }),
    });
    expect(body).toContain('### Notes');
    expect(body).toContain('(role_spoofing, delimiter_escape)');
    expect(body).toContain('treated as data, not instructions');
  });

  it('caps the Notes section at 12 entries', () => {
    const warnings = Array.from({ length: 20 }, (_, i) => `warning number ${i} text here`);
    const body = render({ outcome: baseOutcome({ warnings }) });
    const notesBlock = body.slice(body.indexOf('### Notes'));
    expect((notesBlock.match(/^> /gm) ?? []).length).toBe(12);
  });

  it('escapes the closing paren in the dashboard link so it cannot break the markdown link', () => {
    // As-coded: `)` and whitespace are replaced by %20 (not %29) — enough to
    // keep the link parseable, which is what the helper promises.
    const body = render({ dashboardUrl: 'https://acr.example/r)b' });
    expect(body).toContain('[review dashboard](https://acr.example/r%20b)');
  });
});

describe('sanitizeUntrustedMarkdown', () => {
  it('strips HTML comments, including nested `<!-- <!-- --> -->` tricks', () => {
    expect(sanitizeUntrustedMarkdown('a <!-- hidden --> b')).toBe('a  b');
    expect(sanitizeUntrustedMarkdown('<!-- outer <!-- inner --> outer -->')).toBe('outer');
    // As-coded after this batch: any surviving fragment (`<!--`, `<!-->`,
    // stray `-->`) is removed outright, so output can never start or end a
    // comment — even `<!-->` alone, which CommonMark would treat as a valid
    // empty comment, is deleted rather than passed through. `<!--->` keeps an
    // inert `->` remainder because only the `<!--` opener is matched.
    expect(sanitizeUntrustedMarkdown('<!-->')).toBe('');
    expect(sanitizeUntrustedMarkdown('<!--->')).toBe('->');
    expect(sanitizeUntrustedMarkdown('a<!-->b')).toBe('ab');
    // As-coded: the `<` eaten by tag-stripping leaves an inert `!--` fragment;
    // crucially no `<!--` sequence survives, so no comment can ever start.
    expect(sanitizeUntrustedMarkdown('<a x<!-->')).toBe('a x!--');
  });

  it('neutralizes tags, scripts and event handlers by deleting angle brackets', () => {
    expect(sanitizeUntrustedMarkdown('<script>alert(1)</script>')).toBe('scriptalert(1)/script');
    expect(sanitizeUntrustedMarkdown('<img src=x onerror=alert(1)>')).toBe('img src=x onerror=alert(1)');
    const out = sanitizeUntrustedMarkdown('<a href="https://evil" onclick="steal()">click</a>');
    expect(out).not.toMatch(/<\/?[a-z]/i); // no opening or closing tag survives
    expect(out).not.toContain('<script');
    // As-coded: an attribute-bearing payload like `onerror=` remains as inert
    // plain text — it is only executable inside a real tag, which cannot
    // survive. That is the guarantee the source makes.
  });

  it('de-links [text](url) and images, and unwraps bare autolinks', () => {
    expect(sanitizeUntrustedMarkdown('[click here](https://evil.example)')).toBe('click here (https://evil.example)');
    // The image branch runs first, so `![alt](url)` becomes plain text instead
    // of a half-delinked `!alt (url)`.
    expect(sanitizeUntrustedMarkdown('![img](http://evil/x.png)')).toBe('image: img');
    expect(sanitizeUntrustedMarkdown('<https://evil.example>')).toBe('https://evil.example');
    expect(sanitizeUntrustedMarkdown('[x](javascript:alert(1))')).toBe('x (javascript:alert(1))');
    const evil = sanitizeUntrustedMarkdown('[a](javascript:evil)');
    expect(evil).not.toContain(']('); // no clickable markdown link remains
  });

  it('neutralizes heading markers at line starts but not inline hashes', () => {
    expect(sanitizeUntrustedMarkdown('### Serious\n# One\n## Two')).toBe('Serious\nOne\nTwo');
    expect(sanitizeUntrustedMarkdown('see issue #42')).toBe('see issue #42'); // no space after #
  });

  it('redacts secrets of every tracked shape', () => {
    expect(sanitizeUntrustedMarkdown('token ghp_AAAAAAAAAAAAAAAAABCDEF1234')).toBe('token [REDACTED:github_token]');
    expect(sanitizeUntrustedMarkdown('key sk-abcdefghijklmnopqrstuvwxyz012345')).toBe('key [REDACTED:openai_key]');
    expect(sanitizeUntrustedMarkdown('password: hunter2hunter2')).toBe('password:[REDACTED:assignment]');
    expect(sanitizeUntrustedMarkdown('Authorization: Bearer abcdef123456abcdef123456')).toBe(
      'Authorization: [REDACTED:bearer_header]',
    );
    expect(sanitizeUntrustedMarkdown('AKIAABCDEFGHIJKLMNOP')).toBe('[REDACTED:aws_access_key]');
  });

  it('normalizes CRLF and lone CR, and strips control chars but keeps tab/newline', () => {
    expect(sanitizeUntrustedMarkdown('a\r\nb\rc')).toBe('a\nb\nc');
    expect(sanitizeUntrustedMarkdown('a\u0000b\u001bc\u007fd')).toBe('abcd');
    expect(sanitizeUntrustedMarkdown('keep\ttab\nkeep newline')).toBe('keep\ttab\nkeep newline');
    // ANSI escape sequences are removed as sequences, not leaving `[31m` bits:
    expect(sanitizeUntrustedMarkdown('red\u001b[31mtext\u001b[39m')).toBe('redtext');
    // An ESC-hidden tag becomes parseable before tag-stripping runs:
    expect(sanitizeUntrustedMarkdown('<\u001b[0mscript>evil</\u001b[0mscript>')).toBe('scriptevil/script');
  });

  it('preserves unicode text and emoji', () => {
    expect(sanitizeUntrustedMarkdown('héllo wörld 🔥 😀 — ¡vaya!')).toBe('héllo wörld 🔥 😀 — ¡vaya!');
  });

  it('is idempotent over the whole hostile corpus (second pass changes nothing)', () => {
    const corpus = [
      REVIEW_COMMENT_MARKER,
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[x](javascript:alert(1))',
      '<!--> <!---> <a x<!-->',
      '# h1\n###### h6 not####### seven',
      'a\r\nb\rc\u0000\u001b[31m',
      'ghp_AAAAAAAAAAAAAAAAABCDEF1234 sk-abcdefghijklmnopqrstuvwxyz012345',
      '![img](http://evil/x.png) <https://ok.example>',
      '&lt;script&gt; %3Cscript%3E < sc ript >',
      'héllo 🔥 ```\nfenced\n```',
    ];
    for (const input of corpus) {
      const once = sanitizeUntrustedMarkdown(input);
      expect(sanitizeUntrustedMarkdown(once), `idempotency for ${input.slice(0, 25)}`).toBe(once);
      expect(once).not.toContain('<!--');
      expect(once).not.toContain('-->');
    }
  });

  it('guarantees: no double-decoded link or comment can re-form after ONE pass', () => {
    // As-coded guarantees, asserted explicitly:
    // - `%3Cscript%3E` and `&lt;script&gt;` are NOT decoded; they survive as
    //   literal text (GitHub renders them as visible characters, not markup).
    expect(sanitizeUntrustedMarkdown('%3Cscript%3E')).toBe('%3Cscript%3E');
    expect(sanitizeUntrustedMarkdown('&lt;script&gt;')).toBe('&lt;script&gt;');
    // - A sanitized string contains no tag opener, comment delimiter, or
    //   markdown link syntax that GitHub could activate.
    const nasty = [
      '%3Cscript%3E',
      '&lt;script&gt;',
      '< sc ript >alert(1)</ sc ript >',
      '<scri<!-- -->pt>',
      '<a href=<!-- -->"x">y</a>',
    ].map((s) => sanitizeUntrustedMarkdown(s));
    for (const out of nasty) {
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toContain('<!--');
      expect(out).not.toContain('-->');
      expect(out).not.toMatch(/\[[^\]]+\]\([^)]+\)/);
    }
    // `< sc ript >` survives verbatim as inert text (spaces make it an
    // invalid tag in both the regex and in GitHub's parser) — stated here.
    expect(nasty[2]).toContain('sc ript');
  });

  it('truncates to the field cap with the shared visible notice', () => {
    const long = 'x'.repeat(3000);
    const out = sanitizeUntrustedMarkdown(long);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toMatch(/\[truncated\]$/);
    expect(sanitizeUntrustedMarkdown(long, 50)).toMatch(/\[truncated\]$/);
  });
});

describe('renderReviewComment length cap', () => {
  const manyFindings = (n: number): FindingValidationOutcome[] =>
    Array.from({ length: n }, (_, i) =>
      outcomeFor(
        draft({
          title: `Buffer overflow risk in handler ${i} on path number ${i}`,
          file: `src/handlers/h${i}.ts`,
          line: i + 1,
          description: `description body ${i} `.padEnd(450, 'x'),
        }),
      ),
    );

  it('truncates a >200k-char body to the documented cap with a visible notice', () => {
    const outcome = baseOutcome({
      verdict: 'neutral',
      validated: manyFindings(450),
    });
    const body = render({ outcome });
    expect(body.length).toBeGreaterThan(45_000); // it really got long before capping
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(body).toContain('...[truncated]');
    expect(body.split('\n')[0]).toBe(REVIEW_COMMENT_MARKER); // head, never cut
    expect(countOccurrences(body, REVIEW_COMMENT_MARKER)).toBe(1);
  });

  it('closes a code fence left open by truncation (no unbalanced fence)', () => {
    const fenced = draft({
      title: 'Crash trace\n```\npanic: value error in parser',
      file: 'src/panic.ts',
      line: 5,
    });
    const outcome = baseOutcome({
      verdict: 'failed',
      validated: [outcomeFor(fenced), ...manyFindings(450)],
    });
    const body = render({ outcome });
    expect(fenceCount(body) % 2).toBe(0);
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(body.endsWith('```')).toBe(true);
  });

  it('balances fences even without truncation, staying within cap', () => {
    const fenced = draft({ title: 'Snippet\n```\nbroken block', file: 'src/one.ts', line: 2 });
    const body = render({ outcome: baseOutcome({ validated: [outcomeFor(fenced)] }) });
    expect(fenceCount(body) % 2).toBe(0);
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(MAX_COMMENT_CHARS).toBe(60_000);
  });
});

describe('renderCheckRun', () => {
  function context(over: Partial<ReviewOutcome> = {}): ReviewRenderContext {
    const commands = [
      commandRecord(),
      commandRecord({ kind: 'lint', tool: 'eslint', command: 'npm run lint', status: 'failed', exitCode: 1, durationMs: 4200 }),
      commandRecord({ kind: 'build', tool: 'npm', command: 'npm run build', status: 'skipped', exitCode: null, skippedReason: 'no build script' }),
    ];
    const f = draft({ severity: 'high', title: 'Null dereference on payment session', confidence: 0.9 });
    const entry = outcomeFor(f);
    const validation = [entry];
    const classification = classifyChanges([changedFile('src/service/user.ts'), changedFile('README.md')]);
    return {
      outcome: baseOutcome({
        commands,
        validated: validation,
        findings: [f],
        publishableFindings: [f],
        classification,
        verdict: decideReviewVerdict(
          summarizeFindings([f]),
          commands.map((c) => ({
            kind: c.kind,
            command: c.command,
            status: c.status,
            exitCode: c.exitCode,
            durationMs: c.durationMs,
            stdout: c.stdout,
            stderr: c.stderr,
            timedOut: c.timedOut,
            sandbox: c.sandbox,
            image: c.image,
            ...(c.skippedReason === null ? {} : { skippedReason: c.skippedReason }),
          })),
        ),
        ...over,
      }),
      reviewRunId: 'run-9',
      repositoryFullName: 'acme/widgets',
      pullRequestNumber: 7,
      headSha: 'cccccccccccccccccccccccccccccccccccccccc',
      model: 'test-model',
      durationMs: 5000,
      dashboardUrl: null,
    };
  }

  it('maps a failed verdict to the failure conclusion with counts and command lines', () => {
    const run = renderCheckRun(context());
    expect(run.conclusion).toBe('failure');
    expect(run.title).toBe('Review failed');
    expect(run.summary).toBe('1 high across 1 file(s)');
    expect(run.text).toContain('**AI Code Review — Blocking issues found**');
    expect(run.text).toContain('- 1 high');
    expect(run.text).not.toContain('- 1 medium');
    expect(run.text).toContain('1 file(s) analyzed'); // classifyChanges: one source file (README is documentation)
    expect(run.text).toContain('+ test: passed (1234ms)');
    expect(run.text).toContain('x lint: failed with exit code 1');
    expect(run.text).toContain('- build: skipped (no build script)');
  });

  it('maps passed to success and neutral to neutral conclusions', () => {
    expect(renderCheckRun(context({ verdict: 'passed' })).conclusion).toBe('success');
    expect(renderCheckRun(context({ verdict: 'neutral' })).title).toBe('Review completed with notes');
    expect(renderCheckRun(context({ verdict: null })).conclusion).toBe('neutral'); // null verdict renders neutral
  });

  it('reports none for zero findings and keeps GitHub field limits the source respects', () => {
    const run = renderCheckRun(context({ verdict: 'passed', validated: [], findings: [], publishableFindings: [] }));
    expect(run.text).toContain('Findings:\n- none');
    expect(run.summary).toBe('no findings across 1 file(s)');
    // GitHub check-run limits: title <= 64 chars (documented), summary/text in
    // the 64K range. As-coded: buildCheckRunSummary only guarantees a SHORT
    // fixed-form title/summary; it never caps `text`, and renderCheckRun emits
    // NO per-finding annotations at all (the CheckRunSummary shape has no
    // annotations field), so the 50-annotation GitHub limit is simply not
    // exercised here — the 60K comment cap lives in renderReviewComment.
    expect(run.title.length).toBeLessThanOrEqual(64);
    expect(run.summary).not.toContain('\n'); // summary must be a single line
  });
});

describe('formatDuration', () => {
  it('renders 0ms, sub-second and negative/invalid inputs as sane milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(999)).toBe('999ms');
    // As-coded: sub-second values pass through unsanitized, so fractions show.
    expect(formatDuration(999.4)).toBe('999.4ms');
    expect(formatDuration(-500)).toBe('0ms');
    expect(formatDuration(Number.NaN)).toBe('0ms');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0ms');
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe('0ms');
  });

  it('renders seconds with one decimal below 10s and whole seconds above', () => {
    expect(formatDuration(1_000)).toBe('1.0s');
    expect(formatDuration(9_999)).toBe('10.0s'); // as-coded: still "seconds" bucket, rounds up at the edge
    expect(formatDuration(10_000)).toBe('10s');
    expect(formatDuration(12_345)).toBe('12s');
    expect(formatDuration(59_999)).toBe('60s'); // as-coded: can print 60s rather than rolling into minutes
  });

  it('rebases long durations to hours and never rolls a 60 into the next unit', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(61_500)).toBe('1m 2s'); // rounded once, into whole seconds
    expect(formatDuration(359_999)).toBe('6m 0s'); // separate rounding used to yield "5m 60s"
    expect(formatDuration(3_600_000)).toBe('1h 0m 0s');
    expect(formatDuration(3_723_000)).toBe('1h 2m 3s');
    expect(formatDuration(7_200_000)).toBe('2h 0m 0s');
  });

  it('never emits NaN in any bucket', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, -Infinity]) {
      expect(formatDuration(bad)).toBe('0ms');
    }
    for (const value of [0, 1, 500, 1_000, 59_999, 60_000, 3_600_000]) {
      expect(formatDuration(value)).not.toContain('NaN');
    }
  });
});
