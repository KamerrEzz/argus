# Feature: review feedback loop

Objective: make Argus's reviews produce a trustworthy, closed feedback loop —
the PR comment must communicate progress across runs, a run must never be
silently orphaned in the queue, and the `Inline findings` setting the dashboard
offers must actually work.

Authorized scope: `packages/pipeline`, `packages/shared`, `packages/github`,
`packages/database`, `apps/worker`, and their tests. No architectural changes:
the graph nodes, ports and queue topology stay as they are.

## Problem and why it matters

An end-to-end run on a real pull request exposed three defects. All three were
observed directly, not inferred:

1. **The summary comment hides progress.** `renderReviewComment` renders one
   run's outcome and the published comment is replaced in place, while
   `compareWithPreviousFindings` marks earlier findings `publishable: false`.
   A re-review therefore replaces a comment that listed 2 critical findings with
   one that lists 3 low-severity notes, and the criticals vanish from the PR
   while still unfixed. The reviewer reads "no criticals" and merges.
2. **A run can be orphaned in `QUEUED`.** A `ReviewRun` row was created but no
   BullMQ job existed (`wait`/`active`/`delayed` all zero). There is no reaper,
   sweep or reconciliation, so it stays `QUEUED` forever and the dashboard
   counts it as pending work.
3. **`publishFindingsAsComments` is dead configuration.** The dashboard toggle
   promises "Publish each finding as an inline comment"; no code reads the flag
   and `GithubPublishClient` has no inline review-comment method, so the promise
   is impossible to keep.

## Constraints

- The model still never decides what is safe: policy, budget and publishing
  remain computed from configuration and repository settings.
- No new dependencies, no sandbox/queue/permission topology changes.
- Every behaviour change ships with a regression test.

## Tasks

- [x] **T1 — Summary communicates progress across runs.**
  Render resolved / still-open / new counts in the summary comment by passing the
  previous findings into the render context. Acceptance: a re-review comment
  states what is resolved and what is still open, and never drops a previously
  reported finding without saying so. Tests: `packages/pipeline/test/markdown.unit.test.ts`.
  Evidence: commit `fix(pipeline): report review progress across runs`; 4 new
  markdown tests; `npm run verify` 685/685.

- [x] **T2 — No run stays orphaned in QUEUED.**
  Reconcile runs whose row is `QUEUED` past a threshold with no job in the queue,
  re-enqueueing them once. Acceptance: a `QUEUED` run older than the threshold is
  dispatched on worker start; a healthy run is untouched. Tests: pipeline/queue
  unit tests. Evidence: commit `fix(pipeline): reconcile reviews that lost their
  queue job`; 3 reconciler tests; two dispatches with the same jobId verified to
  leave one job against real Redis; `npm run verify` 688/688.
  Supporting fix: `deduplicationId` is not a BullMQ option (BullMQ reads
  `deduplication.id`), so review jobs were never actually deduplicated.

- [x] **T3 — Inline findings actually publish.**
  Add an inline review-comment capability to the publish port/client and wire it
  to `publishFindingsAsComments`, recording the created comment id per finding.
  Acceptance: with the setting on, publishable findings produce inline comments
  on the changed lines; with it off, nothing inline is posted. Tests: publish
  port + client unit tests. Evidence: commit `feat(pipeline): publish inline
  findings`; `packages/github/test/publish-client.unit.test.ts` (request shape,
  including a multi-line range) and 4 pipeline tests (on/off, ids recorded, a
  rejected line does not fail the publish); `npm run verify` 695/695.
  **Live verification (PR #2 on KamerrEzz/argus-sample, run 2eed6ab8):** before T3,
  with `publishFindingsAsComments: true`, the PR had 0 inline comments and every
  finding had `githubCommentId`/`publishedAt` null. After T3 the same setting
  produced 2 anchored comments (`src/shipping.js:11`, `:10`) and both findings
  recorded their comment ids (4056173158, 4056173171) and `publishedAt`.

- [x] **T4 — A blocking finding is never dropped silently.**
  Investigation of the PR #2 run: the model produced 5 candidates (`submit_findings`
  accepted 5, including "Hardcoded carrier API key committed in source"),
  `validateFinding` kept 2 and discarded 3. The credential candidate was therefore
  discarded by validation, most plausibly through `missing_evidence` — required for
  critical/high and for any `security` category. Neither the discarded candidates
  nor their reasons were recorded anywhere, so the loss was invisible and the
  pull request read as clean.
  Fix: `missing_evidence` no longer discards a critical/high or security finding;
  it keeps it visible and unpublishable, and the validation warning now reports a
  reason histogram instead of a bare count.
  Evidence: commit `fix(shared): stop discarding blocking findings without
  evidence`; `packages/shared/test/findings.unit.test.ts` is a new suite (7 tests —
  no test covered `validateFinding` before); `npm run verify` 702/702.

## Verification

- `npm run verify` (lint + typecheck + typecheck:tests + unit/integration/e2e)
- Targeted: `npx vitest run --project unit packages/pipeline packages/github packages/database`
