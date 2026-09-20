'use client';

// Publish approval inbox for one review run: the requested actions, their
// state, and the approve/reject controls while anything is still pending.

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { errorMessage, formatDateTime, formatRelative, reviews, shortId } from '@/lib/api';
import type { Approval, ReviewRunDetail } from '@/lib/types';
import {
  Card,
  DangerButton,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  Shell,
  StatusBadge,
  inputClass,
} from '@/components/layout';
import { useToast } from '@/components/toast';

export default function ReviewApprovalsPage() {
  return (
    <Shell>
      <ReviewApprovalsView />
    </Shell>
  );
}

function ReviewApprovalsView() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const toast = useToast();

  const [run, setRun] = useState<ReviewRunDetail | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detail, list] = await Promise.all([reviews.get(id), reviews.approvals(id)]);
      setRun(detail);
      setApprovals(list.length > 0 ? [...list].reverse() : detail.approvals);
    } catch (error) {
      toast.error(errorMessage(error));
      setRun(null);
      setApprovals([]);
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(action: 'publish' | 'reject') {
    setBusy(action);
    try {
      if (action === 'publish') {
        await reviews.publish(id, reason.trim().length > 0 ? reason.trim() : undefined);
        toast.success('Approved — the review will be published to GitHub.');
      } else {
        await reviews.reject(id, reason.trim().length > 0 ? reason.trim() : undefined);
        toast.success('Rejected — nothing will be published.');
      }
      setReason('');
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4" role="status" aria-label="Loading approvals">
        <div className="h-8 w-72 animate-pulse rounded bg-surface-raised" />
        <div className="h-48 animate-pulse rounded-xl bg-surface" />
        <span className="sr-only">Loading approvals…</span>
      </div>
    );
  }

  if (run === null) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <h2 className="text-lg font-semibold text-ink">Review run unavailable</h2>
        <Link
          href="/reviews"
          className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas hover:bg-accent/90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Back to review runs
        </Link>
      </div>
    );
  }

  const pending = approvals.filter((approval) => approval.status === 'pending');
  const canDecide = run.status === 'awaiting_approval' && pending.length > 0;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`Approvals · review ${shortId(run.id)}`}
        description={`${run.repository.fullName} · ${run.pullRequest !== null ? `#${run.pullRequest.number} ${run.pullRequest.title}` : 'pull request removed'}`}
        actions={
          <div className="flex gap-2">
            <Link
              href={`/reviews/${run.id}`}
              className="inline-flex items-center rounded-lg border border-border-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-muted hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              Back to run
            </Link>
            <SecondaryButton
              onClick={() => {
                void load();
              }}
            >
              Refresh
            </SecondaryButton>
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <StatusBadge status={run.status} />
        {pending.length > 0 ? (
          <span className="font-medium text-status-neutral" role="status">
            {pending.length} approval(s) awaiting a decision
          </span>
        ) : (
          <span className="text-ink-muted" role="status">
            Nothing waiting on you.
          </span>
        )}
      </div>

      {canDecide && (
        <Card title="Record a decision" className="mb-6 border-status-neutral">
          <form
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              void decide('publish');
            }}
            className="space-y-3"
          >
            <label htmlFor="approval-reason" className="sr-only">
              Optional reason for the decision
            </label>
            <textarea
              id="approval-reason"
              rows={2}
              maxLength={2000}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              placeholder="Optional note — recorded with the approval decision"
              className={inputClass}
            />
            <div className="flex flex-wrap gap-2">
              <PrimaryButton type="submit" busy={busy === 'publish'}>
                Approve &amp; publish
              </PrimaryButton>
              <DangerButton
                type="button"
                busy={busy === 'reject'}
                onClick={() => {
                  void decide('reject');
                }}
              >
                Reject
              </DangerButton>
            </div>
          </form>
          <p className="mt-2 text-xs text-ink-faint">
            Requires triage access on the repository. Approval requeues the exact snapshot shown on
            the run page.
          </p>
        </Card>
      )}

      <Card title="Approval requests">
        {approvals.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No approval was ever requested for this run. Repositories that do not require approval
            publish directly when a review completes.
          </p>
        ) : (
          <ol className="space-y-3">
            {approvals.map((approval) => (
              <li
                key={approval.id}
                className="rounded-lg border border-border-subtle bg-surface-raised px-4 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-sm font-medium text-ink">{approval.action}</p>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      approval.status === 'approved'
                        ? 'bg-status-success text-canvas'
                        : approval.status === 'rejected'
                          ? 'bg-status-failure text-canvas'
                          : approval.status === 'expired'
                            ? 'bg-surface text-ink-faint'
                            : 'bg-status-neutral text-canvas'
                    }`}
                  >
                    {approval.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  Requested {formatDateTime(approval.requestedAt)}
                  {approval.decidedAt !== null && ` · decided ${formatRelative(approval.decidedAt)}`}
                  {approval.decidedById !== null && approval.decidedById !== undefined && (
                    ` · by ${approval.decidedById}`
                  )}
                </p>
                {approval.reason !== null && approval.reason.trim().length > 0 && (
                  <p className="mt-2 text-sm text-ink-muted">“{approval.reason}”</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
