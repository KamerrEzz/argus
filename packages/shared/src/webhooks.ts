import { z } from 'zod';
import type { ChangedFileStatus } from './github-types';
import { CHANGED_FILE_STATUSES } from './github-types';

export const PullRequestWebhookSchema = z.object({
  action: z.string().min(1),
  number: z.number().int().positive().optional(),
  repository: z.object({
    id: z.number().int(),
    name: z.string().min(1),
    full_name: z.string().min(1),
    private: z.boolean().optional(),
    default_branch: z.string().optional(),
    owner: z.object({ login: z.string().min(1) }).optional(),
  }),
  installation: z.object({ id: z.number().int() }).optional(),
  sender: z.object({ login: z.string().min(1) }).optional(),
  pull_request: z.object({
    id: z.number().int().optional(),
    number: z.number().int().positive(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    draft: z.boolean().optional(),
    state: z.string().optional(),
    merged: z.boolean().nullable().optional(),
    html_url: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    merged_at: z.string().nullable().optional(),
    additions: z.number().int().optional(),
    deletions: z.number().int().optional(),
    changed_files: z.number().int().optional(),
    labels: z.array(z.object({ name: z.string() })).optional(),
    user: z.object({ login: z.string().min(1) }).optional(),
    head: z.object({ ref: z.string().optional(), sha: z.string().min(1) }),
    base: z.object({ ref: z.string().optional(), sha: z.string().min(1) }),
  }),
});
export type PullRequestWebhookPayload = z.infer<typeof PullRequestWebhookSchema>;

export const PullRequestEventSchema = z.object({
  event: z.string().min(1),
  payload: z.unknown(),
});

export const REVIEW_TRIGGER_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review'] as const;

export type PullRequestAction = (typeof REVIEW_TRIGGER_ACTIONS)[number];

export function isReviewTriggerAction(action: string): action is PullRequestAction {
  return (REVIEW_TRIGGER_ACTIONS as readonly string[]).includes(action);
}

export function isRepoChangeStatus(status: string): status is ChangedFileStatus {
  return (CHANGED_FILE_STATUSES as readonly string[]).includes(status);
}

export const REVIEW_COMMENT_MARKER = '<!-- acr:review-summary -->';
export const FINDING_COMMENT_MARKER_PREFIX = '<!-- acr:finding:';

export function findingCommentMarker(fingerprint: string): string {
  return `${FINDING_COMMENT_MARKER_PREFIX}${fingerprint} -->`;
}
