# Argus

**The hundred-eyed reviewer for every pull request.**

![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

An agent that reads your pull requests like a senior engineer: it clones the head
commit, runs the project's real checks in a sandbox, reads the surrounding code
through tools, and publishes one honest review — findings with file/line anchors,
a verdict, and a GitHub check run — back to the pull request.

It is a self-hosted platform, not a hosted bot. You own the data, the model
spend, and the review policy.

> Packages keep the `@acr` scope (the project's original working name) and the CLI
> binary is `acr-review`; the product name is Argus.

> **Documentation:** [`docs/index.html`](docs/index.html) — the same material as
> this file, in English and Spanish, as one self-contained page with no build step.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Quickstart](#quickstart)
- [Connecting GitHub](#connecting-github)
- [Configuration](#configuration)
- [Running a review from the CLI](#running-a-review-from-the-cli)
- [HTTP API](#http-api)
- [Review pipeline](#review-pipeline)
- [Sandboxing and permissions](#sandboxing-and-permissions)
- [Publish approval gate](#publish-approval-gate)
- [Costs and budgets](#costs-and-budgets)
- [Development](#development)
- [Testing](#testing)
- [Production deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)
- [Notes on this codebase](#notes-on-this-codebase)

---

## What it does

| | |
| --- | --- |
| **Triggers** | `pull_request` opened / synchronize / ready_for_review webhooks, the dashboard's "Run review" button, the CLI, or a retry of a finished run |
| **Reads** | the PR diff, the full changed files, and any file in the repository — the agent asks for them through tools, it is not handed a fixed blob |
| **Runs** | `npm test` / lint / typecheck / build and any `static_analysis` / `security_scan` script it finds, in a Docker sandbox (or a locked-down process fallback) |
| **Reports** | findings validated against a schema, deduplicated, calibrated by confidence, anchored to a file and line; one summary comment (updated in place, never spammed) and one check run with annotations |
| **Remembers** | every run: nodes executed, tool calls, command output, tokens, cost, findings, and the previous run's findings — so the second review says what changed instead of repeating itself |

Two properties are deliberate and shape everything below:

1. **The model never decides what is safe.** Permissions, budgets, sandbox policy,
   and the publish gate are computed from configuration and repository settings.
   A model that asks to run a command is denied unless a human already granted it.
2. **Pull-request content is attacker-controlled.** Titles, bodies, diffs, file
   names and code comments all pass through injection scanning, secret redaction
   and markdown neutralisation before they reach a prompt or the published comment.

---

## Architecture

```
                    ┌──────────────┐
   GitHub ──webhook▶│    apps/api   │◀──── browser (dashboard, SSE)
                    └──────┬───────┘
                    enqueue│writes
                           ▼
              ┌────────────────────────┐
              │ Postgres   Redis       │  system of record / queue+streams
              └────────────────────────┘
                           ▲
                           │reads/writes
                    ┌──────┴───────┐
                    │  apps/worker  │  BullMQ consumers
                    └──────┬───────┘
                           │
        ┌──────────────────┼───────────────────┐
        ▼                  ▼                   ▼
  @acr/pipeline      @acr/ai (LangGraph)   @acr/sandbox
  orchestration      graph + tools         docker / process
  + publishing       + prompts + cost      + git + workspace
        │                  │                   │
        └────── @acr/github ── @acr/queue ── @acr/database ── @acr/shared ── @acr/config ─┘
```

### Packages

| Package | Responsibility |
| --- | --- |
| `@acr/config` | One zod-validated `AppConfig` from the environment, plus the pino logger. Nothing reads `process.env` anywhere else |
| `@acr/shared` | Pure domain: findings, severities, budgets, permissions, review types, classification, prompt security, ports, settings, webhooks, text/secret redaction |
| `@acr/database` | Prisma schema, client lifecycle, the `ReviewPersistencePort` implementation, auth store, queries, approval and repository helpers, seed |
| `@acr/github` | Dependency-free REST client (App installation tokens or a PAT), JWT signing with `node:crypto`, read + publish clients, webhook signature verification |
| `@acr/sandbox` | Command specs validated against an allow-list, Docker and process runners, git operations, workspace management, package-manifest introspection |
| `@acr/queue` | BullMQ queues and workers, Redis Streams event bus (SSE replay + live tail), distributed locks with renewal |
| `@acr/ai` | The LangGraph review graph: context, analysis, agent loop with tools, validation, finalize. Provider-agnostic LLM layer and a scripted provider for tests |
| `@acr/pipeline` | The composition root: builds every port, wires graph → persistence → publishing, owns locking, idempotency and the approval gate |

### Apps

| App | What it is |
| --- | --- |
| `apps/api` | Fastify server: session auth, repositories, pull requests, reviews, findings, approvals, SSE, GitHub webhooks |
| `apps/worker` | BullMQ consumer: review runs, publish runs, and queued sandbox commands |
| `apps/web` | Next.js dashboard: repositories, pull requests, live review detail, findings, approvals inbox |
| `apps/cli` | One-shot review runner for local trials and CI (`npm run review`) |

Every layer talks through the interfaces in `@acr/shared/ports`. That is what makes
the test doubles, the CLI, and the no-Redis fallback paths real configurations
rather than special-case code.

---

## Quickstart

Requirements: Node.js ≥ 22.12 (developed on 26), npm workspaces, Docker for the
sandbox and infrastructure, and an LLM endpoint.

```bash
npm install
cp .env.example .env          # then set AUTH_SECRET (64 hex chars) and LLM_API_KEY
npm run dev:infra             # postgres + redis in containers
npm run db:generate
npm run db:migrate            # applies prisma/migrations
npm run build:backend         # tsc -b across all packages and apps
npm run dev                   # api :4000, worker, web :3000
```

`AUTH_SECRET` signs session cookies:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

To get a signed-in user without touching GitHub, set the bootstrap admin trio in
`.env` before the API boots — it only ever creates the first user:

```
BOOTSTRAP_ADMIN_EMAIL=you@example.com
BOOTSTRAP_ADMIN_PASSWORD=a-long-random-passphrase
BOOTSTRAP_ADMIN_NAME=You
```

Then sign in at <http://localhost:3000>, add a repository, and open a pull request.

Without Docker, or before you wire the sandbox, set:

```
SANDBOX_MODE=process
ALLOW_PROCESS_SANDBOX=true
```

Checks then run as child processes of the API/worker with a scrubbed environment,
a hard timeout, and no shell. That is a real (weaker) sandbox, not a stub — the
review still works and says which checks ran and which were skipped.

---

## Connecting GitHub

Two modes, and they are independent — you can use either one alone.

### GitHub App (recommended)

1. Create an App. Note the **App ID** and the **slug**.
2. Generate a **private key** (PEM) and keep it out of the repository.
3. Permissions: *Contents: read*, *Issues: write* (comments), *Pull requests:
   read + write*, *Checks: write*.
4. Subscribe it to the repositories you want reviewed.
5. In `.env`: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_PRIVATE_KEY` (or
   `GITHUB_PRIVATE_KEY_PATH`), `GITHUB_WEBHOOK_SECRET`.
6. Point the App's webhook URL at `https://<your-host>/github/webhooks` with the
   `pull_request` event, using the same secret.

The PEM can be provided inline (`GITHUB_PRIVATE_KEY`, with `\n` escapes) or as a
path (`GITHUB_PRIVATE_KEY_PATH`).

### Personal access token

Set `GITHUB_TOKEN` to a token that can comment and create check runs on the target
repositories. Webhook delivery is still verified if `GITHUB_WEBHOOK_SECRET` is set;
without it, the endpoint rejects every request rather than trusting unverified input.

### Local webhook testing

`GITHUB_WEBHOOK_SECRET=dev-webhook-secret` plus a forwarder (`smee.io`, `ngrok`)
pointed at `/github/webhooks` works unchanged — the route is signature-gated,
deduplicated by delivery id, and records every delivery it accepts.

---

## Configuration

All variables are validated in `packages/config/src/env.ts`; startup fails with a
list of what is wrong instead of booting half-configured. `.env.example` documents
every one. The values that change behaviour the most:

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_SECRET` | — | Session signing key. Required, ≥ 32 chars |
| `DATABASE_URL` | — | Postgres connection string |
| `REDIS_URL` | — | Redis connection string. Optional: without it the system runs inline (see below) |
| `SANDBOX_MODE` | `docker` | `docker` \| `process` \| `off` |
| `ALLOW_PROCESS_SANDBOX` | `false` | Must be `true` for `process` mode — an explicit opt-in to the weaker sandbox |
| `SANDBOX_NETWORK` | `none` | `none` blocks package installs during checks |
| `REVIEW_COMMAND_EXECUTION` | `inline` | `inline` runs checks in the reviewing process; `queued` dispatches them as worker jobs (requires Redis; `docker-compose.yml` sets `queued`) |
| `LLM_PROVIDER` | `openai-compatible` | `openai` \| `openrouter` \| `nan-builders` \| `openai-compatible`; the named ones carry a default base URL |
| `LLM_BASE_URL` | — | Explicit endpoint; overrides the provider preset. Required for `openai-compatible` |
| `LLM_MODEL` | `gpt-4o-mini` | Model id; OpenRouter uses `vendor/model`, nan.builders uses ids like `glm5.3-flash` |
| `LLM_HTTP_REFERER` / `LLM_APP_TITLE` | — | OpenRouter app-attribution headers (optional; only sent for `openrouter`) |
| `REVIEW_MAX_TOKENS` | `200000` | Per-review token budget |
| `REVIEW_MAX_DURATION_MS` | `900000` | Per-review wall clock |
| `REVIEW_MAX_TOOL_CALLS` | `60` | Agent loop cap |
| `REVIEW_MIN_PUBLISH_CONFIDENCE` | `0.6` | Below it, findings are kept but suppressed |
| `REVIEW_REQUIRE_APPROVAL_FOR_PUBLISH` | `false` | Adds the human gate described below |
| `API_PUBLIC_URL` | `http://localhost:4000` | Used for dashboard links in published comments |

Provider presets (every one speaks OpenAI Chat Completions, so tool calls and
JSON mode behave identically):

```bash
# OpenRouter
LLM_PROVIDER=openrouter
LLM_API_KEY=sk-or-...
LLM_MODEL=openai/gpt-4o
LLM_HTTP_REFERER=https://your-app.example   # optional app attribution
LLM_APP_TITLE=ACR                           # optional app attribution

# nan.builders
LLM_PROVIDER=nan-builders
LLM_API_KEY=sk-...
LLM_MODEL=glm5.3-flash

# Any other gateway (local or hosted)
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://gateway.internal/v1
LLM_MODEL=my-model
```

Per-repository settings (stored in the database, editable in the dashboard or via
`PATCH /repositories/:id/settings`) narrow or widen these defaults inside the bounds the
deployment allows: which checks to run, deep review, suggestions, publish toggle,
ignored paths, and the agent's permission set.

### Running with no Redis at all

If `REDIS_URL` is unset or unreachable, the container probes it at startup and
falls back: reviews run **inline** in the API process, locks become in-process, and
events use an in-memory bus. The dashboard's live tail still works, but events do
not survive a restart — which is why `status` reports this as a degraded mode
rather than a feature.

---

## Running a review from the CLI

`apps/cli` runs one review end to end without the dashboard, and without Redis:
checks execute inline and events stay in-process.

```bash
npm run review -- --repo owner/name --pr 42
```

| Flag | Effect |
| --- | --- |
| `--repo`, `--repository` | repository as `owner/name` (required) |
| `--pr`, `--number` | pull request number (required) |
| `--publish` | post the summary comment and check run to GitHub. **Off by default** — a local trial must never surprise the author |
| `--no-checks` | skip test/lint/typecheck execution entirely |
| `--model <name>` | override `LLM_MODEL` for this one run |
| `--fresh` | force a new review run for the same head commit instead of reusing it |
| `--json` | print one machine-readable result object |
| `--quiet` | only print the final result |
| `-h`, `--help` | usage |

The first run reads the repository and the pull request straight from GitHub and
records both, so a PR shows up in the dashboard without waiting for a webhook. It
needs `DATABASE_URL`, a working GitHub credential and a model key; Redis is
optional.

A typical local loop:

```bash
npm run review -- --repo owner/name --pr 42 --no-checks   # fastest: AI pipeline only
npm run review -- --repo owner/name --pr 42               # plus sandboxed checks
npm run review -- --repo owner/name --pr 42 --publish     # write back to GitHub
```

The CLI exits non-zero when the run fails, so it can be used as a CI step.

---

## HTTP API

Everything the dashboard uses, in plain HTTP with a session cookie. Routes are not
prefixed: the API is either served on its own host or routed by your ingress.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Process up: version, uptime, dependency probes. Never fails, never rate limited |
| `GET` | `/ready` | 200 only when the database answers; also lists configuration issues |
| `POST` | `/auth/login` | Email + password, rate limited, sets the `acr_session` cookie |
| `POST` | `/auth/logout` | Clears the cookie and bumps the token version |
| `GET` | `/auth/me` | Current user, or 401 |
| `GET` `POST` | `/auth/users` | Admin only: list, create |
| `POST` | `/auth/users/:userId/revoke-sessions` | Admin only: force re-login |
| `GET` `POST` | `/repositories` | List what you can see; add a repository (admin) |
| `POST` | `/repositories/sync` | Pull the GitHub App installation's repository list |
| `GET` | `/repositories/:id` | Detail plus recent activity |
| `PATCH` | `/repositories/:id/settings` | Review policy for this repository |
| `GET` `PUT` `DELETE` | `/repositories/:id/access` | Grant, replace, or revoke a user's access |
| `GET` | `/pull-requests` | Filterable by repository, author, state |
| `GET` | `/pull-requests/:id` | Detail with its review history |
| `POST` | `/pull-requests/:id/sync` | Re-fetch head sha, title, and file list from GitHub |
| `POST` | `/pull-requests/:id/review` | Trigger a review; returns the run id immediately |
| `GET` `POST` | `/reviews` | List runs; create one by repository + number |
| `GET` | `/reviews/:id` | Status, plan, usage, cost, node trace |
| `GET` | `/reviews/:id/findings` | Paginated, filterable by severity and category |
| `GET` | `/reviews/:id/approvals` | Pending and decided publish approvals |
| `POST` | `/reviews/:id/publish` | Approve and publish the stored snapshot |
| `POST` | `/reviews/:id/reject` | Cancel without publishing |
| `POST` | `/reviews/:id/retry` | New run for the same head, with a fresh idempotency key |
| `GET` | `/reviews/:id/events` | Server-Sent Events: replay from `Last-Event-ID`, then tail live |
| `POST` | `/github/webhooks` | Signature-verified, delivery-deduplicated |

Errors are a single envelope — `{ code, message, details, requestId }` — with codes
mirroring the HTTP status (`validation_error`, `unauthorized`, `forbidden`,
`not_found`, `conflict`, `internal_error`). Every response carries `x-request-id`,
which is also the key in the logs.

---

## Review pipeline

One review, step by step:

1. **Trigger** — webhook (verified, deduplicated by delivery id), API call, CLI, or retry.
2. **Enqueue** — a `ReviewRun` row is created with an idempotency key derived from
   `(repository, pull request, head sha, trigger)`. A push that fires three webhooks
   produces one review.
3. **Lock** — a Redis lock on `review:<pullRequestId>` keeps two workers from
   reviewing the same pull request at once.
4. **Prepare** — clone the head commit (shallow, `GIT_CLONE_DEPTH`) into a workspace
   keyed by the run, and fetch the PR metadata, commits and file list from GitHub.
5. **Classify** — changed files are bucketed (source, test, docs, generated, …); the
   review plan decides which checks are worth running.
6. **Run checks** — the planned scripts execute in the sandbox; output is parsed into
   findings with real file/line anchors.
7. **Agent loop** — the model reads files, searches the repo, requests additional
   commands, and drafts findings, bounded by budget and permissions.
8. **Validate** — each draft is schema-checked, deduplicated, calibrated against
   `REVIEW_MIN_PUBLISH_CONFIDENCE`, and compared with the previous run's findings.
   When two or more candidates survive that deterministic pass, an adversarial
   model critique may only discard or soften them — never strengthen or add —
   and any uplift attempt is recorded instead of applied. A single surviving
   candidate skips the model call (cost) and stands on the deterministic rules.
9. **Finalize** — a verdict (`passed` / `neutral` / `failed`), a narrative, counts.
10. **Publish** — summary comment (found and updated in place via an embedded marker)
    and a check run with annotations; or a pending approval when the gate is on.

Every step streams events (`run.started`, `node.*`, `tool.*`, `check.*`,
`finding.created`, `run.completed`, `heartbeat`) to a Redis Stream, which the
dashboard replays and tails over SSE. A crashed worker is detected by the lock
expiring, and the run is resumable because each step is idempotent.

---

## Sandboxing and permissions

| Mode | What happens | Isolation |
| --- | --- | --- |
| `docker` | `docker run --rm` with CPU/memory/PID limits, a writable per-run workspace mount (the only writable path beside a 256 MB `/tmp` tmpfs), `--network none` by default, `--cap-drop ALL`, `no-new-privileges`, and a command allow-list | Container |
| `process` | Direct `child_process` with scrubbed environment, no shell, hard timeout, kill on expiry | Process only — opt-in with `ALLOW_PROCESS_SANDBOX=true` |
| `off` | No commands run; the review is code-reading only and says so | None |

The agent does not get a shell. It gets structured commands from a catalog built by
reading the repository's own `package.json`, validated against a script allow-list,
with argument-injection guards, output caps, and timeouts. Commands are
deterministically keyed so a retried review does not re-run work it already did.

Permissions are a set intersection: what the deployment grants, what the repository
settings grant, and what the agent role needs — minus `review:publish` whenever
approval is required. Repository settings can only narrow the agent's standing
set, never widen it: grants outside the agent role's ceiling (`pull_request:write`,
`repository:configure`, `review:approve`) are dropped before the graph starts.
The model cannot widen this set by asking.

---

## Publish approval gate

With `REVIEW_REQUIRE_APPROVAL_FOR_PUBLISH=true` (or the repository setting), a
finished review writes nothing to GitHub. Instead the rendered artifacts — the exact
comment body and check-run payload — are snapshotted into a `ReviewApproval` row and
the run moves to `awaiting_approval`.

An approving human then publishes **that snapshot**, not a re-render: what you read
in the dashboard is byte-for-byte what lands on the pull request. Rejecting cancels
the run and leaves the author with nothing. Both decisions are attributed and audited.

The dashboard has an inbox for it; so does `POST /reviews/:id/publish`.

---

## Costs and budgets

`BudgetTracker` bounds every run: max tokens, max cost, max duration, max tool
calls, max iterations. On exhaustion the graph stops cleanly, marks the run
`partial`, and publishes what it already knows with a banner saying what was not
analyzed — a truncated review is still useful, a silent one is not.

Token usage is recorded per node against configurable per-1K pricing, so the
dashboard shows where the money went and the summary comment shows the total.

---

## Development

```bash
npm run dev          # api + worker + web concurrently
npm run dev:api      # one process
npm run build        # db:generate + build:backend + build:web
npm run typecheck    # every project, including tests
npm run lint
npm run format
```

Backend modules are CommonJS with TypeScript project references, so
`tsc -b tsconfig.build.json` builds packages before their dependents and emits
`dist/` + declaration maps everywhere. `apps/web` is a normal Next.js App Router app.

Adding a capability usually means: extend the port in `@acr/shared`, implement it in
the owning package, wire it in `@acr/pipeline`, and surface it in `apps/api` +
`apps/web`. If you find yourself reaching across a package boundary, that is the
port layer telling you the interface moved.

### Repository layout

```
apps/       api  worker  web  cli
packages/   config  shared  database  github  sandbox  queue  ai  pipeline
tests/      end-to-end suites
prisma/     packages/database/prisma/schema.prisma + migrations/
```

---

## Testing

```bash
npm run test:unit          # pure logic, no infrastructure
npm run test:integration   # needs postgres + redis (npm run dev:infra)
npm run test:e2e           # full request → review → publish with a scripted model
npm run test:e2e:web       # Playwright: the real dashboard against the real API
npm run test               # all of the above
```

The unit layer runs without Docker, a database, or a model: it is where the command
allow-list, injection scanning, secret redaction, budget arithmetic, markdown
sanitisation and finding validation are pinned down. Integration tests use the real
Prisma store and real Redis streams. End-to-end tests drive `requestReview` →
`executeReview` against a local fixture repository with a scripted model provider, so
publishing is asserted without spending a token or touching GitHub. The web suite
(`apps/web/e2e`, 22 tests) drives the built dashboard in Chromium against the
compiled API: login, repositories, pull requests, review detail, the approval
inbox, the live SSE tail, and the settings form — with review triggering asserted
through its graceful no-credentials failure path. It boots both servers itself;
run `npm run build` first so it serves current output.

The test layer has already earned its keep: it found coercion bypasses in the
command validator, silent zero-finding parses on ANSI and Windows paths, secret
patterns that missed `DB_PASSWORD`, and a publish path that dropped the reviewer's
narrative entirely.

---

## Production deployment

`docker-compose.yml` defines `postgres`, `redis`, `migrate`, `api`, `worker`, `web`.

```bash
docker compose build
docker compose up -d
docker compose logs -f api worker
```

- `Dockerfile` builds one backend image with `api` and `worker` targets — same
  dependency set, different entrypoint.
- The `migrate` service runs `prisma migrate deploy` and gates `api` with
  `service_completed_successfully`, so no pod serves traffic on an old schema.
- `api` and `worker` share the `workspaces` volume, which is what makes `REVIEW_COMMAND_EXECUTION=queued`
  work: the worker opens the exact path the API created.
- Set `COOKIE_SECURE=true` behind TLS, and put the real `GITHUB_WEBHOOK_SECRET` and
  `AUTH_SECRET` in the environment rather than in a committed file. The API already
  runs with `trustProxy` enabled, so `X-Forwarded-*` from your ingress is honored.
- Scale by adding workers; BullMQ and the per-pull-request lock make that safe.
- The worker image carries the Docker CLI. Only mount `/var/run/docker.sock` if you
  accept that a container can then control the host daemon; it is commented out in
  the compose file for that reason.

Health: `GET /health` reports version, uptime and dependency probes and never
fails; `GET /ready` gates on the database only and also lists configuration issues,
so a process with a healthy database but degraded Redis still serves reads while
saying exactly what is missing. Both are unauthenticated and rate-limit exempt.

---

## Troubleshooting

| Symptom | Where to look |
| --- | --- |
| Webhook returns 401 | `GITHUB_WEBHOOK_SECRET` mismatch, or a proxy that re-serialised the JSON body — verification uses the raw bytes |
| No reviews start | `GET /ready`; then the `webhook_events` table, which records accepted deliveries and why they were skipped |
| Review stuck in `running` | The worker died: the lock expires after `QUEUE_JOB_TIMEOUT_MS`, and the next attempt resumes from persisted state |
| `skipped (sandbox unavailable)` | `SANDBOX_MODE=docker` without a reachable daemon, or `ALLOW_PROCESS_SANDBOX=false` with mode `process` |
| Checks fail with network errors | `SANDBOX_NETWORK=none` is deliberate; dependencies must already be installed in the image or workspace |
| Comments appear twice on one pull request | Only if the first was published before the summary marker existed — the updater matches on `REVIEW_COMMENT_MARKER`; check `review_runs` for a second completed run on the same head sha |
| Cost higher than expected | `REVIEW_MAX_FILES`, `REVIEW_MAX_DIFF_BYTES` and `deepReviewAllowed` are the levers; the dashboard's per-node trace shows where |
| Model 429/5xx | `LLM_MAX_RETRIES` with backoff; the run ends `failed` with the sanitized reason rather than retrying forever |

---

## Notes on this codebase

- The GitHub client is written against `fetch` rather than Octokit: the current
  Octokit majors are ESM-only, which fights this repo's CommonJS backend build.
- Prisma is pinned to 6.19. Prisma 7 deprecates both the `package.json#prisma`
  configuration this package uses and the `prisma-client-js` generator output, so
  the upgrade is a deliberate migration (config file plus client output location)
  rather than a version bump.
- `@langchain/core`, `@langchain/langgraph` and `@langchain/openai` are pinned to the
  majors this code was written against. If you bump them, the graph state annotations
  and the checkpointer contracts are the first places to look.
