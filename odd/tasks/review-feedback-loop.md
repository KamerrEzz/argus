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
  **Live verification (PR #2 re-run on the merged code):** before the fix the run
  kept 2 of 5 candidates and the credential was gone from the report. After the
  fix the same diff keeps it — `Carrier API key hardcoded in source`
  (`src/shipping.js:4`, security, confidence 90%, suppressed) now appears in the
  pull-request comment, together with the SQL injection (`:7`, security, 85%) and
  the missing await (`:11`, bug, 85%). The warning now reads
  `1 finding(s) discarded during validation: validated ×1,
  second_reviewer_discarded: Redundant with finding #0 ... (the hardcoded
  CARRIER_API_KEY)`, so a drop is auditable instead of silent.
  Open policy question: these findings stay unpublishable (and the check stays
  neutral) because the model supplied no evidence. Whether a high-confidence
  security finding should block without evidence is a product decision, not a
  defect.

- [x] **T5 — A blocking finding must carry evidence.**
  Chosen over relaxing the policy: the cause is that the model is never required
  to point at the line it read, so its critical/high/security findings can never
  be published. `submit_findings` now rejects such a finding and fails the whole
  submission, so the model cannot make the error go away by dropping the finding;
  the system prompt states the rule up front. T4 remains the net for anything that
  still reaches validation without evidence.
  Evidence: commit `feat(ai): require evidence for critical, high and security
  findings`; `packages/ai/test/submit-findings.unit.test.ts` (5 tests);
  `npm run verify` 707/707.

- [x] **T6 — The run records the GitHub artefacts it created.**
  `markReviewPublished` was implemented and had no callers, so `ReviewRun.commentId`
  and `checkRunId` stayed null and nothing tied a run to its comment or check run.
  `publishArtifacts` now keeps the ids it gets back and records them, null when an
  artefact was skipped or failed, and records nothing when publishing is switched
  off.
  Evidence: commit; 3 tests; `npm run verify`.

- [x] **T7 — `db:seed` is idempotent after the API bootstrap.**
  The seed upserted the admin by its fixed id while the API bootstrap creates the
  same email with an id of its own, so `npm run db:seed` failed with P2002 on
  `user.email`. The seed now adopts the id the email already carries and points its
  access rows at it; the password is deliberately left alone on update, so
  reseeding never invalidates a real account's credentials.
  Evidence: commit; integration test in
  `packages/database/test/database.integration.test.ts`; verified live by inserting
  an admin with a foreign id and seeding twice — both succeed and the row keeps its
  id.

- [x] **T8 — the loop closes end to end.** With the sample PR's code fixed
  (`argus-sample` PR #2), the review went from `failed` with the credential
  published inline to `neutral`: the blocking findings are gone, the check run went
  from `failure` to `neutral`, and the comment's progress section reported the
  earlier findings as not raised again.

- [x] **T9 — the container image builds.**
  `docker compose build` failed with `Cannot find module '@acr/shared'` on any
  machine that had built locally. `.dockerignore` excluded `**/dist` but not
  `*.tsbuildinfo`, so the host's incremental build metadata travelled into the
  image; `tsc -b` then considered every project up to date and emitted no `dist`,
  and the dependants could not resolve their workspace packages. Excluding the
  metadata fixes the image, and teaching each package's `clean` script to remove
  its own `tsconfig.tsbuildinfo` fixes the same trap locally (delete `dist`, keep
  the metadata, and the next build silently emits nothing).
  Evidence: commit; `docker compose build api` succeeds; `docker compose run --rm
  migrate` applies migrations inside the container; `npm run clean -w @acr/shared`
  followed by `npm run build:backend` succeeds.

- [x] **T10 — the full stack runs in containers.** Bringing `docker compose up -d`
  up exposed four defects the host test suite cannot see:
  1. The web image failed to build: `next build` ran with `NODE_ENV=development`,
     so prerendering `/_global-error` threw `Cannot read properties of null
     (reading 'useContext')`. The build stage now switches to production for the
     build step while keeping development for `npm ci`.
  2. The api and worker images exited on start: `LOG_PRETTY=true` — the value
     `.env.example` shipped — made pino load `pino-pretty`, a devDependency the
     production image prunes. The logger now falls back to JSON and says so, and
     the example defaults to false.
  3. The web container could not find its server: `COPY .next/standalone /repo`
     copies the *contents*, so the server lands at `apps/web/server.js`, not at the
     nested path the CMD used.
  4. The worker image was stale from before the `.dockerignore` fix (T9), so it
     carried no `dist`; rebuilding every image resolved it.
  Evidence: `docker compose build` succeeds for every image; with all five
  containers up the API answers `/health` with database, redis, git and llm ok,
  the web serves 200 for `/login`, and the worker reports healthy on its own
  endpoint with `checks: queued`.

- [x] **T11 — the container deploy can reach GitHub.** Compose passed
  `GITHUB_PRIVATE_KEY` only, so a deployment that keeps the key in a file — the
  README's recommended shape, and what a local `.env` typically uses — reached the
  container with no credential at all and every review failed with "Repository has
  no GitHub App installation and GITHUB_TOKEN is not configured".
  Evidence: `GITHUB_PRIVATE_KEY_PATH` is passed through and the PEM mount is
  documented beside the api and worker volumes.
  **Deploy checklist item, not a code defect:** `NODE_ENV` is substituted from the
  host `.env` (`${NODE_ENV:-production}`), so a container run inherits
  `development` unless the deployment sets it explicitly — and the production
  invariant checks only run when it is `production`. Set `NODE_ENV=production` in
  the deploy environment.

## Verification

- `npm run verify` (lint + typecheck + typecheck:tests + unit/integration/e2e)
- Targeted: `npx vitest run --project unit packages/pipeline packages/github packages/database`

## Operational note: the suite and a live stack share Redis

The e2e suite drives a review in-process against the same `DATABASE_URL` and
`REDIS_URL` the containers use. With a worker consuming that Redis — for example
after `docker compose up -d` — an old `QUEUED` run for the test's own repository
can be re-dispatched by the reconciler and hold the pull-request lock, so the
test's review comes back `status: 'skipped'` with
`skippedReason: 'already_running'`. That is the reconciler doing its job against a
dirty development database, not a product defect: stop the app containers
(`docker compose stop api worker web`) before running the suite, or give the tests
their own Redis.
