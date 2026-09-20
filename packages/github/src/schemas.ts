import { z } from 'zod';

export const GithubUserSchema = z.object({ login: z.string().min(1) });

export const GithubLabelSchema = z.union([z.string(), z.object({ name: z.string() })]);

export const GithubPullRequestSchema = z.object({
  id: z.number().int(),
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged: z.boolean().nullable().optional(),
  merged_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  changed_files: z.number().int().optional(),
  html_url: z.string(),
  user: GithubUserSchema.nullable().optional(),
  labels: z.array(GithubLabelSchema).optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() }),
});
export type GithubPullRequestPayload = z.infer<typeof GithubPullRequestSchema>;

export const GithubPullRequestFileSchema = z.object({
  sha: z.string(),
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changes: z.number().int().optional(),
  patch: z.string().optional(),
  binary: z.boolean().optional(),
});
export type GithubPullRequestFilePayload = z.infer<typeof GithubPullRequestFileSchema>;

export const GithubRepositorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  language: z.string().nullable().optional(),
  owner: GithubUserSchema,
});
export type GithubRepositoryPayload = z.infer<typeof GithubRepositorySchema>;

export const GithubContentSchema = z.object({
  type: z.string(),
  name: z.string(),
  path: z.string(),
  sha: z.string(),
  size: z.number().int(),
  encoding: z.string().optional(),
  content: z.string().optional(),
  download_url: z.string().nullable().optional(),
});

export const GithubBlobSchema = z.object({
  sha: z.string(),
  size: z.number().int().optional(),
  encoding: z.string(),
  content: z.string(),
});

export const GithubTreeSchema = z.object({
  sha: z.string(),
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
      size: z.number().int().optional(),
    }),
  ),
});

export const GithubSearchCodeSchema = z.object({
  total_count: z.number().int(),
  incomplete_results: z.boolean().optional(),
  items: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      sha: z.string(),
    }),
  ),
});

export const GithubIssueCommentSchema = z.object({
  id: z.number().int(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  created_at: z.string(),
  user: GithubUserSchema.nullable().optional(),
});
export type GithubIssueCommentPayload = z.infer<typeof GithubIssueCommentSchema>;

export const GithubCheckRunSchema = z.object({
  id: z.number().int(),
  html_url: z.string().nullable().optional(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  details_url: z.string().nullable().optional(),
});
export type GithubCheckRunPayload = z.infer<typeof GithubCheckRunSchema>;

export const GithubInstallationTokenSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  repository_selection: z.string().optional(),
});

export const GithubInstallationSchema = z.object({
  id: z.number().int(),
  account: z.object({ login: z.string(), type: z.string() }),
  repository_selection: z.string().optional(),
  app_id: z.number().int().optional(),
});

export const GithubInstallationRepositoriesSchema = z.object({
  total_count: z.number().int(),
  repositories: z.array(GithubRepositorySchema),
});
