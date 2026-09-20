// Typed fetch wrapper around the ACR API.
//
// The API lives on its own origin (dev: http://localhost:4000) and keeps the
// session in the httpOnly `acr_session` cookie it sets on POST /auth/login.
// Every request therefore goes out with `credentials: 'include'`; the API's
// CORS config allows exactly the web origin with credentials.
//
// Failures never throw raw: non-2xx responses are parsed into an ApiError
// carrying the API envelope `{ code, message, details, requestId }`, and
// network/CORS failures become a synthetic `network_error` the UI can toast.

import type {
  Approval,
  ManagedUser,
  PullRequestDetail,
  PullRequestListItem,
  RepositoryDetail,
  RepositoryListItem,
  RepositorySettingsPatch,
  ReviewFinding,
  ReviewRequestResult,
  ReviewRunDetail,
  ReviewRunListItem,
  Severity,
  SyncRepositoriesResult,
  User,
} from './types';

export const API_BASE: string =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || 'http://localhost:4000';

export const SESSION_COOKIE_NAME = 'acr_session';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(
    message: string,
    options: {
      status: number;
      code: string;
      details?: unknown;
      requestId?: string | null;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details ?? null;
    this.requestId = options.requestId ?? null;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/** Normalized pagination envelope computed from `{ items, total, take, skip }`. */
export interface ListResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as JSON. POST/PUT/PATCH with no body send `{}` because the API expects JSON. */
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
}

export function withQuery(path: string, query?: QueryParams): string {
  if (query === undefined) {
    return path;
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}

interface RawEnvelope {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  requestId?: unknown;
}

function parseList<T>(raw: unknown, query?: QueryParams): ListResult<T> {
  const record = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(record['items']) ? (record['items'] as T[]) : [];
  const total = typeof record['total'] === 'number' ? record['total'] : items.length;
  const take = typeof record['take'] === 'number' && record['take'] > 0 ? record['take'] : items.length;
  const skip = typeof record['skip'] === 'number' ? record['skip'] : 0;
  const requestedPage = Number(query?.['page'] ?? 1);
  const page =
    typeof record['page'] === 'number'
      ? record['page']
      : take > 0
        ? Math.floor(skip / take) + 1
        : Number.isFinite(requestedPage)
          ? requestedPage
          : 1;
  const pageSize = take > 0 ? take : 20;
  const totalPages =
    typeof record['totalPages'] === 'number'
      ? Math.max((record['totalPages'] as number) ?? 1, 1)
      : Math.max(Math.ceil(total / pageSize), 1);
  return { items, total, page, pageSize, totalPages };
}

async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal } = options;
  const init: RequestInit = {
    method,
    credentials: 'include',
    cache: 'no-store',
    signal,
    headers: { Accept: 'application/json' },
  };
  if (method !== 'GET') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${withQuery(path, query)}`, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError(
      'Could not reach the API. Is the server running and reachable?',
      { status: 0, code: 'network_error', details: error instanceof Error ? error.message : null },
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as RawEnvelope;
    const code = typeof envelope.code === 'string' ? envelope.code : 'http_error';
    const message =
      typeof envelope.message === 'string' && envelope.message.length > 0
        ? envelope.message
        : defaultMessageForStatus(response.status);
    throw new ApiError(message, {
      status: response.status,
      code,
      details: envelope.details ?? null,
      requestId: typeof envelope.requestId === 'string' ? envelope.requestId : null,
    });
  }

  return (payload ?? undefined) as T;
}

function defaultMessageForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'The request was rejected';
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return 'You do not have permission for that action';
    case 404:
      return 'Not found';
    case 409:
      return 'That conflicts with the current state';
    case 422:
      return 'The server could not validate the request';
    case 429:
      return 'Too many requests — please slow down';
    default:
      return 'The server failed the request';
  }
}

export function apiGet<T>(path: string, query?: QueryParams, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET', query, signal });
}

export function apiPost<T>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
  return request<T>(path, { method: 'POST', body, query });
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body });
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

export async function apiList<T>(
  path: string,
  query?: QueryParams,
  signal?: AbortSignal,
): Promise<ListResult<T>> {
  const raw = await request<unknown>(path, { method: 'GET', query, signal });
  return parseList<T>(raw, query);
}

/** Turn anything thrown into a single line of toast-worthy text. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const suffix = error.requestId ? ` (ref ${error.requestId})` : '';
    return `${error.message}${suffix}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------- auth helpers

export async function login(email: string, password: string): Promise<User> {
  const result = await apiPost<{ user: User }>('/auth/login', { email, password });
  return result.user;
}

export async function logout(): Promise<void> {
  await apiPost<{ status: string }>('/auth/logout');
}

export async function fetchMe(signal?: AbortSignal): Promise<User> {
  const result = await apiGet<{ user: User }>('/auth/me', undefined, signal);
  return result.user;
}

export async function fetchUsers(signal?: AbortSignal): Promise<ManagedUser[]> {
  const result = await apiGet<{ users: ManagedUser[] }>('/auth/users', undefined, signal);
  return result.users;
}

// ---------------------------------------------------------------- domain calls

export const repositories = {
  list(query: QueryParams, signal?: AbortSignal): Promise<ListResult<RepositoryListItem>> {
    return apiList<RepositoryListItem>('/repositories', query, signal);
  },
  get(id: string, signal?: AbortSignal): Promise<RepositoryDetail> {
    return apiGet<{ repository: RepositoryDetail }>(
      `/repositories/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ).then((r) => r.repository);
  },
  create(owner: string, name: string): Promise<RepositoryListItem> {
    return apiPost<{ repository: RepositoryListItem }>('/repositories', { owner, name }).then(
      (r) => r.repository,
    );
  },
  sync(): Promise<SyncRepositoriesResult> {
    return apiPost<SyncRepositoriesResult>('/repositories/sync');
  },
  updateSettings(id: string, patch: RepositorySettingsPatch): Promise<RepositoryListItem> {
    return apiPatch<{ repository: RepositoryListItem }>(
      `/repositories/${encodeURIComponent(id)}/settings`,
      patch,
    ).then((r) => r.repository);
  },
  grantAccess(id: string, userId: string, permission: string): Promise<{ status: string }> {
    return apiPut<{ status: string }>(`/repositories/${encodeURIComponent(id)}/access`, {
      userId,
      permission,
    });
  },
  revokeAccess(id: string, userId: string): Promise<{ status: string }> {
    return apiDelete<{ status: string }>(
      `/repositories/${encodeURIComponent(id)}/access/${encodeURIComponent(userId)}`,
    );
  },
};

export const pullRequests = {
  list(query: QueryParams, signal?: AbortSignal): Promise<ListResult<PullRequestListItem>> {
    return apiList<PullRequestListItem>('/pull-requests', query, signal);
  },
  get(id: string, signal?: AbortSignal): Promise<PullRequestDetail> {
    return apiGet<{ pullRequest: PullRequestDetail }>(
      `/pull-requests/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ).then((r) => r.pullRequest);
  },
  sync(id: string): Promise<PullRequestDetail> {
    return apiPost<{ pullRequest: PullRequestDetail }>(
      `/pull-requests/${encodeURIComponent(id)}/sync`,
    ).then((r) => r.pullRequest);
  },
  review(id: string): Promise<ReviewRequestResult> {
    return apiPost<ReviewRequestResult>(`/pull-requests/${encodeURIComponent(id)}/review`);
  },
};

export const reviews = {
  list(query: QueryParams, signal?: AbortSignal): Promise<ListResult<ReviewRunListItem>> {
    return apiList<ReviewRunListItem>('/reviews', query, signal);
  },
  get(id: string, signal?: AbortSignal): Promise<ReviewRunDetail> {
    return apiGet<{ review: ReviewRunDetail }>(
      `/reviews/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ).then((r) => r.review);
  },
  findings(id: string, query?: QueryParams, signal?: AbortSignal): Promise<ReviewFinding[]> {
    return apiGet<{ findings: ReviewFinding[] }>(
      `/reviews/${encodeURIComponent(id)}/findings`,
      query,
      signal,
    ).then((r) => r.findings);
  },
  approvals(id: string, signal?: AbortSignal): Promise<Approval[]> {
    return apiGet<{ approvals: Approval[] }>(
      `/reviews/${encodeURIComponent(id)}/approvals`,
      undefined,
      signal,
    ).then((r) => r.approvals);
  },
  create(repository: string, pullRequestNumber: number, trigger = 'manual'): Promise<ReviewRequestResult> {
    return apiPost<ReviewRequestResult>('/reviews', {
      repository,
      pullRequestNumber,
      trigger,
    });
  },
  publish(id: string, reason?: string): Promise<unknown> {
    return apiPost<unknown>(`/reviews/${encodeURIComponent(id)}/publish`, { reason });
  },
  reject(id: string, reason?: string): Promise<unknown> {
    return apiPost<unknown>(`/reviews/${encodeURIComponent(id)}/reject`, { reason });
  },
  retry(id: string): Promise<ReviewRequestResult> {
    return apiPost<ReviewRequestResult>(`/reviews/${encodeURIComponent(id)}/retry`);
  },
};

/** SSE endpoint URL. `after` replays from a stored event id (Last-Event-ID is sent automatically on reconnect). */
export function reviewEventsUrl(id: string, after?: string | null): string {
  return `${API_BASE}${withQuery(`/reviews/${encodeURIComponent(id)}/events`, after ? { after } : undefined)}`;
}

// ---------------------------------------------------------------- formatting

const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const timeFormatter = new Intl.DateTimeFormat('en', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormatter.format(date);
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : timeFormatter.format(date);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days} d ago`;
  }
  return formatDateTime(iso);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) {
    return '—';
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${Math.round(seconds % 60)} s`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return new Intl.NumberFormat('en').format(value);
}

export function formatUsd(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const amount = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (Number.isNaN(amount)) {
    return '—';
  }
  return `$${amount.toFixed(amount >= 1 ? 2 : 4)}`;
}

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Extract a displayable path from a `changedFiles` JSON entry of unknown shape. */
export function changedFileLabel(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry !== null && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    for (const key of ['filename', 'file', 'path']) {
      const value = record[key];
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return JSON.stringify(entry) ?? 'unknown';
}

// ---------------------------------------------------------------- SARIF export

interface SarifArtifact {
  location: { uri: string };
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: { physicalLocation: { artifactLocation: SarifArtifact['location']; region?: { startLine: number } } }[];
  properties: Record<string, unknown>;
}

function severityToSarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') {
    return 'error';
  }
  if (severity === 'medium') {
    return 'warning';
  }
  return 'note';
}

/**
 * The API does not ship a SARIF route, so the dashboard renders the same
 * findings into SARIF 2.1.0 client-side. Viewers (VS Code, GitHub code
 * scanning) accept the file unchanged.
 */
export function buildSarifReport(review: ReviewRunDetail): string {
  const rules = new Map<string, { id: string; shortDescription: { text: string }; properties: { tags: string[] } }>();
  const results: SarifResult[] = [];

  for (const finding of review.findings) {
    const ruleId = finding.ruleId ?? `acr/${finding.category}`;
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        shortDescription: { text: finding.title },
        properties: { tags: [finding.category, finding.source] },
      });
    }
    const text = [finding.title, finding.description, finding.suggestion ? `Suggestion: ${finding.suggestion}` : null]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n\n');
    results.push({
      ruleId,
      level: severityToSarifLevel(finding.severity),
      message: { text },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: finding.file ?? 'unknown' },
            ...(finding.line !== null ? { region: { startLine: finding.line } } : {}),
          },
        },
      ],
      properties: {
        severity: finding.severity,
        confidence: finding.confidence,
        status: finding.status,
        source: finding.source,
        reviewRunId: review.id,
      },
    });
  }

  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0' as const,
    runs: [
      {
        tool: {
          driver: {
            name: 'AI Code Review & QA Agent',
            informationUri: 'https://github.com/acme/ai-code-review',
            version: review.model,
            rules: [...rules.values()],
          },
        },
        results,
        originalUriBaseIds: {
          REPO_ROOT: { uri: `https://github.com/${review.repository.fullName}/tree/${review.headSha}/` },
        },
        columnKind: 'utf16CodeUnits' as const,
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

/** Trigger a browser download for generated text content. */
export function downloadTextFile(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
