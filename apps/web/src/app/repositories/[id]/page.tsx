'use client';

// Repository detail: review policy settings, agent permissions, access
// management, recent activity, and manual review triggering.
//
// Settings are edited against a local draft and saved with
// `PATCH /repositories/:id/settings`, which merges the submitted keys.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  errorMessage,
  fetchUsers,
  formatRelative,
  repositories,
  reviews,
} from '@/lib/api';
import type {
  AgentPermission,
  ManagedUser,
  RepositoryDetail,
  RepositorySettings,
  RepositorySettingsPatch,
  Severity,
} from '@/lib/types';
import {
  Card,
  DangerButton,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  Shell,
  StatusBadge,
  VerdictBadge,
  inputClass,
  labelClass,
  useSession,
} from '@/components/layout';
import { useToast } from '@/components/toast';

const ALL_PERMISSIONS: readonly AgentPermission[] = [
  'repository:read',
  'pull_request:read',
  'pull_request:write',
  'checks:write',
  'comments:write',
  'code_execution:execute',
  'review:publish',
  'repository:configure',
  'review:approve',
];

const ALL_SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const ACCESS_LEVELS = ['read', 'triage', 'write', 'maintain', 'admin'] as const;

export default function RepositoryDetailPage() {
  return (
    <Shell>
      <RepositoryDetailView />
    </Shell>
  );
}

function RepositoryDetailView() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const toast = useToast();
  const { user } = useSession();

  const [repo, setRepo] = useState<RepositoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRepo(await repositories.get(id));
      setNotFound(false);
    } catch (error) {
      toast.error(errorMessage(error));
      setRepo(null);
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4" role="status" aria-label="Loading repository">
        <div className="h-8 w-72 animate-pulse rounded bg-surface-raised" />
        <div className="h-40 animate-pulse rounded-xl bg-surface" />
        <div className="h-64 animate-pulse rounded-xl bg-surface" />
        <span className="sr-only">Loading repository…</span>
      </div>
    );
  }

  if (notFound || repo === null) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <h2 className="text-lg font-semibold text-ink">Repository unavailable</h2>
        <p className="mt-2 text-sm text-ink-muted">
          It either does not exist or you do not have access to it.
        </p>
        <Link
          href="/repositories"
          className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas hover:bg-accent/90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Back to repositories
        </Link>
      </div>
    );
  }

  const canManage =
    user?.role === 'admin' ||
    (user !== null && repo.access.some((entry) => entry.userId === user.id && entry.permission === 'admin'));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={repo.fullName}
        description={`${repo.isPrivate ? 'Private' : 'Public'} · default branch ${repo.defaultBranch}${repo.language !== null ? ` · ${repo.language}` : ''}`}
        actions={
          <SecondaryButton
            onClick={() => {
              void load();
            }}
          >
            Reload
          </SecondaryButton>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MiniStat label="Pull requests" value={String(repo.counts.pullRequests)} />
        <MiniStat label="Review runs" value={String(repo.counts.reviewRuns)} />
        <MiniStat label="Published findings" value={String(repo.counts.findings)} />
        <MiniStat label="Members" value={String(repo.counts.members)} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {canManage ? (
            <SettingsForm repo={repo} onSaved={load} />
          ) : (
            <SettingsSummary settings={repo.settings} />
          )}
          <AccessCard repo={repo} canManage={canManage} onChanged={load} />
        </div>

        <div className="space-y-6">
          <TriggerReviewCard repo={repo} />
          <RecentActivityCard repo={repo} />
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-3">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------- settings

type BooleanSettingKey = {
  [K in keyof RepositorySettings]-?: RepositorySettings[K] extends boolean ? K : never;
}[keyof RepositorySettings];

function toggleRow(
  key: BooleanSettingKey,
  label: string,
  description: string,
  draft: DraftSettings,
  setDraft: (updater: (prev: DraftSettings) => DraftSettings) => void,
): ReactNode {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-xs text-ink-faint">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={draft[key]}
        aria-label={label}
        onClick={() => {
          setDraft((prev) => ({ ...prev, [key]: !prev[key] }));
        }}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
          draft[key] ? 'bg-accent' : 'bg-border-strong'
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-canvas transition-transform ${
            draft[key] ? 'translate-x-5' : ''
          }`}
        />
      </button>
    </div>
  );
}

type DraftSettings = RepositorySettings & { ignorePathsText: string };

function toDraft(settings: RepositorySettings): DraftSettings {
  return {
    ...settings,
    failOnSeverities: [...settings.failOnSeverities],
    ignorePaths: [...settings.ignorePaths],
    agentPermissions: {
      granted: [...settings.agentPermissions.granted],
      denied: [...settings.agentPermissions.denied],
    },
    ignorePathsText: settings.ignorePaths.join('\n'),
  };
}

function SettingsForm({ repo, onSaved }: { repo: RepositoryDetail; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<DraftSettings>(() => toDraft(repo.settings));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(toDraft(repo.settings));
  }, [repo.settings]);

  function set<K extends keyof RepositorySettings>(key: K, value: RepositorySettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const patch: RepositorySettingsPatch = {
      enabled: draft.enabled,
      reviewDrafts: draft.reviewDrafts,
      enableTests: draft.enableTests,
      enableLint: draft.enableLint,
      enableTypecheck: draft.enableTypecheck,
      enableSecurityScan: draft.enableSecurityScan,
      enableAiReview: draft.enableAiReview,
      deepReview: draft.deepReview,
      minPublishConfidence: draft.minPublishConfidence,
      failOnSeverities: draft.failOnSeverities,
      publishSummaryComment: draft.publishSummaryComment,
      publishFindingsAsComments: draft.publishFindingsAsComments,
      createCheckRun: draft.createCheckRun,
      requireApprovalToPublish: draft.requireApprovalToPublish,
      ignorePaths: draft.ignorePathsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      maxFiles: draft.maxFiles,
      instructionHints: draft.instructionHints,
      agentPermissions: draft.agentPermissions,
    };
    if (Number.isNaN(patch.minPublishConfidence) || Number.isNaN(patch.maxFiles)) {
      toast.error('Confidence and file limit must be numbers.');
      return;
    }
    setBusy(true);
    repositories
      .updateSettings(repo.id, patch)
      .then(() => {
        toast.success('Settings saved.');
        onSaved();
      })
      .catch((error: unknown) => {
        toast.error(errorMessage(error));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  const setDraftFn = (updater: (prev: DraftSettings) => DraftSettings) => setDraft(updater);

  return (
    <Card
      title="Review policy"
      actions={
        <PrimaryButton type="submit" form="settings-form" busy={busy}>
          Save settings
        </PrimaryButton>
      }
    >
      <form id="settings-form" onSubmit={submit} className="space-y-8">
        <fieldset>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Checks &amp; review depth
          </legend>
          {toggleRow('enabled', 'Reviews enabled', 'Run reviews automatically on pull request events', draft, setDraftFn)}
          {toggleRow('reviewDrafts', 'Review drafts', 'Include draft pull requests', draft, setDraftFn)}
          {toggleRow('enableTests', 'Run tests', 'Execute the repository test suite in the sandbox', draft, setDraftFn)}
          {toggleRow('enableLint', 'Run lint', 'Execute the repository lint script', draft, setDraftFn)}
          {toggleRow('enableTypecheck', 'Run typecheck', 'Execute the repository typecheck script', draft, setDraftFn)}
          {toggleRow('enableSecurityScan', 'Security scan', 'Static security analysis on changed files', draft, setDraftFn)}
          {toggleRow('enableAiReview', 'AI review', 'Let the agent reason about the diff', draft, setDraftFn)}
          {toggleRow('deepReview', 'Deep review', 'Multi-agent review for risky or large changes', draft, setDraftFn)}
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Publishing
          </legend>
          {toggleRow('publishSummaryComment', 'Summary comment', 'Publish one review summary to the pull request', draft, setDraftFn)}
          {toggleRow('publishFindingsAsComments', 'Inline findings', 'Publish each finding as an inline comment', draft, setDraftFn)}
          {toggleRow('createCheckRun', 'Check run', 'Report the verdict as a GitHub check', draft, setDraftFn)}
          {toggleRow('requireApprovalToPublish', 'Require approval', 'A reviewer must approve before anything is published', draft, setDraftFn)}

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="min-confidence" className={labelClass}>
                Min publish confidence (0–1)
              </label>
              <input
                id="min-confidence"
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={Number.isNaN(draft.minPublishConfidence) ? '' : draft.minPublishConfidence}
                onChange={(event) => {
                  set('minPublishConfidence', Number.parseFloat(event.target.value));
                }}
                className={`mt-1.5 ${inputClass}`}
              />
            </div>
            <div>
              <label htmlFor="max-files" className={labelClass}>
                Max files per review
              </label>
              <input
                id="max-files"
                type="number"
                step="1"
                min="1"
                max="1000"
                value={Number.isNaN(draft.maxFiles) ? '' : draft.maxFiles}
                onChange={(event) => {
                  set('maxFiles', Number.parseInt(event.target.value, 10));
                }}
                className={`mt-1.5 ${inputClass}`}
              />
            </div>
          </div>

          <div className="mt-4">
            <p className={labelClass}>Fail the check on severities</p>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Blocking severities">
              {ALL_SEVERITIES.map((severity) => {
                const active = draft.failOnSeverities.includes(severity);
                return (
                  <button
                    key={severity}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      set(
                        'failOnSeverities',
                        active
                          ? draft.failOnSeverities.filter((entry) => entry !== severity)
                          : [...draft.failOnSeverities, severity],
                      );
                    }}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                      active
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-border-strong text-ink-muted hover:text-ink'
                    }`}
                  >
                    {severity}
                  </button>
                );
              })}
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Ignored paths
          </legend>
          <label htmlFor="ignore-paths" className="sr-only">
            Ignored paths, one glob pattern per line
          </label>
          <textarea
            id="ignore-paths"
            rows={4}
            value={draft.ignorePathsText}
            onChange={(event) => {
              setDraft((prev) => ({ ...prev, ignorePathsText: event.target.value }));
            }}
            placeholder={'**/generated/**\nvendor/**'}
            className={`mt-1.5 font-mono ${inputClass}`}
          />
          <p className="mt-1 text-xs text-ink-faint">One glob pattern per line. Matching files are skipped.</p>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Instruction hints
          </legend>
          <label htmlFor="instruction-hints" className="sr-only">
            Extra instructions for the reviewer
          </label>
          <textarea
            id="instruction-hints"
            rows={3}
            maxLength={4000}
            value={draft.instructionHints}
            onChange={(event) => {
              set('instructionHints', event.target.value);
            }}
            placeholder="e.g. This service must stay backward compatible; flag any public API change."
            className={`mt-1.5 ${inputClass}`}
          />
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Agent permissions
          </legend>
          <ul className="space-y-1">
            {ALL_PERMISSIONS.map((permission) => {
              const state: 'granted' | 'none' | 'denied' = draft.agentPermissions.denied.includes(
                permission,
              )
                ? 'denied'
                : draft.agentPermissions.granted.includes(permission)
                  ? 'granted'
                  : 'none';
              return (
                <li
                  key={permission}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-1 py-1.5 odd:bg-surface-raised"
                >
                  <span className="font-mono text-xs text-ink">{permission}</span>
                  <span
                    className="flex gap-1"
                    role="radiogroup"
                    aria-label={`Permission ${permission}`}
                  >
                    {(['granted', 'none', 'denied'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={state === option}
                        onClick={() => {
                          setDraft((prev) => {
                            const granted = new Set(prev.agentPermissions.granted);
                            const denied = new Set(prev.agentPermissions.denied);
                            granted.delete(permission);
                            denied.delete(permission);
                            if (option === 'granted') {
                              granted.add(permission);
                            } else if (option === 'denied') {
                              denied.add(permission);
                            }
                            return {
                              ...prev,
                              agentPermissions: {
                                granted: [...granted],
                                denied: [...denied],
                              },
                            };
                          });
                        }}
                        className={`rounded px-2 py-0.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                          state === option
                            ? option === 'denied'
                              ? 'bg-status-failure font-medium text-canvas'
                              : option === 'granted'
                                ? 'bg-status-success font-medium text-canvas'
                                : 'bg-border-strong text-ink'
                            : 'text-ink-faint hover:text-ink'
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </fieldset>
      </form>
    </Card>
  );
}

function SettingsSummary({ settings }: { settings: RepositorySettings }) {
  const rows: readonly [string, boolean][] = [
    ['Reviews enabled', settings.enabled],
    ['Review drafts', settings.reviewDrafts],
    ['Tests', settings.enableTests],
    ['Lint', settings.enableLint],
    ['Typecheck', settings.enableTypecheck],
    ['Security scan', settings.enableSecurityScan],
    ['AI review', settings.enableAiReview],
    ['Deep review', settings.deepReview],
    ['Summary comment', settings.publishSummaryComment],
    ['Inline findings', settings.publishFindingsAsComments],
    ['Check run', settings.createCheckRun],
    ['Require approval', settings.requireApprovalToPublish],
  ];
  return (
    <Card title="Review policy (read-only)">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-2">
            <dt className="text-sm text-ink-muted">{label}</dt>
            <dd className={`text-sm font-medium ${value ? 'text-status-success' : 'text-ink-faint'}`}>
              {value ? 'on' : 'off'}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 text-sm text-ink-muted">
        <p>
          Min publish confidence:{' '}
          <span className="font-mono text-ink">{settings.minPublishConfidence}</span> · Max files:{' '}
          <span className="font-mono text-ink">{settings.maxFiles}</span>
        </p>
        <p className="mt-1">
          Fails on:{' '}
          <span className="font-mono text-ink">{settings.failOnSeverities.join(', ') || 'nothing'}</span>
        </p>
        {settings.ignorePaths.length > 0 && (
          <p className="mt-1">
            Ignored paths: <span className="font-mono text-ink">{settings.ignorePaths.join(', ')}</span>
          </p>
        )}
        {settings.instructionHints.length > 0 && (
          <p className="mt-2 rounded-lg bg-surface-raised p-3 text-ink">{settings.instructionHints}</p>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- access

function AccessCard({
  repo,
  canManage,
  onChanged,
}: {
  repo: RepositoryDetail;
  canManage: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { user } = useSession();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<(typeof ACCESS_LEVELS)[number]>('read');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage || user?.role !== 'admin') {
      return;
    }
    fetchUsers()
      .then(setUsers)
      .catch(() => {
        // Non-admin fetchers simply get the manual user-id field.
        setUsers([]);
      });
  }, [canManage, user?.role]);

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (userId.trim().length === 0) {
      toast.error('Pick or enter a user first.');
      return;
    }
    setBusy('grant');
    try {
      await repositories.grantAccess(repo.id, userId.trim(), permission);
      toast.success('Access granted.');
      setUserId('');
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(targetUserId: string) {
    setBusy(targetUserId);
    try {
      await repositories.revokeAccess(repo.id, targetUserId);
      toast.success('Access revoked.');
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Access management">
      {repo.access.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Nobody has been granted access to this repository yet. Platform administrators can always
          reach it.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {repo.access.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{entry.name}</p>
                <p className="truncate font-mono text-xs text-ink-faint">{entry.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
                  {entry.permission}
                </span>
                {canManage && (
                  <DangerButton
                    onClick={() => {
                      void revoke(entry.userId);
                    }}
                    busy={busy === entry.userId}
                    className="px-2.5 py-1 text-xs"
                  >
                    Revoke
                  </DangerButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <form onSubmit={grant} className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
          <div className="min-w-48 flex-1">
            <label htmlFor="grant-user" className={labelClass}>
              User
            </label>
            {users.length > 0 ? (
              <select
                id="grant-user"
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                }}
                className={`mt-1.5 ${inputClass}`}
              >
                <option value="">Select a user…</option>
                {users.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.email})
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input
                  id="grant-user"
                  value={userId}
                  onChange={(event) => {
                    setUserId(event.target.value);
                  }}
                  placeholder="user id"
                  className={`mt-1.5 font-mono ${inputClass}`}
                />
                <p className="mt-1 text-xs text-ink-faint">
                  Paste a user id — the full user list is admin-only.
                </p>
              </>
            )}
          </div>
          <div>
            <label htmlFor="grant-permission" className={labelClass}>
              Permission
            </label>
            <select
              id="grant-permission"
              value={permission}
              onChange={(event) => {
                setPermission(event.target.value as (typeof ACCESS_LEVELS)[number]);
              }}
              className={`mt-1.5 ${inputClass}`}
            >
              {ACCESS_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>
          <PrimaryButton type="submit" busy={busy === 'grant'}>
            Grant access
          </PrimaryButton>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- trigger + activity

function TriggerReviewCard({ repo }: { repo: RepositoryDetail }) {
  const toast = useToast();
  const router = useRouter();
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = Number.parseInt(number, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      toast.error('Enter a pull request number greater than zero.');
      return;
    }
    setBusy(true);
    try {
      const result = await reviews.create(repo.fullName, parsed, 'manual');
      toast.success(
        result.created ? 'Review run created.' : 'A run for this head already exists.',
      );
      router.push(`/reviews/${result.reviewRunId}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Trigger a review">
      <form onSubmit={submit} className="flex items-end gap-3">
        <div className="flex-1">
          <label htmlFor="trigger-pr" className={labelClass}>
            Pull request number
          </label>
          <input
            id="trigger-pr"
            type="number"
            min="1"
            inputMode="numeric"
            value={number}
            onChange={(event) => {
              setNumber(event.target.value);
            }}
            placeholder="e.g. 42"
            className={`mt-1.5 ${inputClass}`}
            required
          />
        </div>
        <PrimaryButton type="submit" busy={busy}>
          Run
        </PrimaryButton>
      </form>
      <p className="mt-3 text-xs text-ink-faint">
        Requires triage access on this repository. The run is deduplicated per head commit.
      </p>
    </Card>
  );
}

function RecentActivityCard({ repo }: { repo: RepositoryDetail }) {
  return (
    <Card title="Recent activity">
      {repo.recentReviews.length === 0 ? (
        <p className="text-sm text-ink-muted">No review runs yet for this repository.</p>
      ) : (
        <ol className="space-y-3" aria-label="Recent review runs">
          {repo.recentReviews.map((run) => (
            <li key={run.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  href={`/reviews/${run.id}`}
                  className="rounded text-sm font-medium text-ink hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  {run.pullRequest !== null
                    ? `#${run.pullRequest.number} ${run.pullRequest.title}`
                    : 'Review run'}
                </Link>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {formatRelative(run.createdAt)} · {run.findingsTotal} finding(s)
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <StatusBadge status={run.status} />
                <VerdictBadge verdict={run.verdict} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
