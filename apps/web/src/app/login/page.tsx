'use client';

// Login page. Reads the optional ?next redirect from the query string at
// submit time (not via useSearchParams) to keep the route statically
// renderable.

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, login } from '@/lib/api';
import { PrimaryButton, inputClass, labelClass, useSession } from '@/components/layout';
import { useToast } from '@/components/toast';

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const { status, refresh } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Already signed in? Land on the dashboard.
  useEffect(() => {
    if (status === 'authed') {
      router.replace('/');
    }
  }, [status, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setEmailError(null);
    setPasswordError(null);

    if (email.trim().length === 0) {
      setEmailError('Email is required');
      return;
    }
    if (password.length === 0) {
      setPasswordError('Password is required');
      return;
    }

    setSubmitting(true);
    try {
      const user = await login(email.trim(), password);
      await refresh();
      toast.success(`Welcome back, ${user.name}.`);
      const target = safeRedirectTarget(window.location.search);
      router.replace(target);
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      if (cause instanceof ApiError && cause.code === 'rate_limited') {
        toast.error('Too many login attempts. Wait a minute before trying again.');
      } else {
        toast.error(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (status === 'authed') {
    return null;
  }

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12"
    >
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-base font-bold text-canvas"
          >
            AR
          </span>
          <div>
            <p className="text-lg font-semibold text-ink">AI Code Review</p>
            <p className="text-xs text-ink-faint">Review &amp; QA console</p>
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface p-6">
          <h1 className="text-base font-semibold text-ink">Sign in</h1>
          <p className="mt-1 mb-5 text-sm text-ink-muted">
            Use your platform account to reach repositories, pull requests and review runs.
          </p>

          {error !== null && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-status-failure bg-surface-raised px-3 py-2 text-sm text-status-failure"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <label htmlFor="email" className={labelClass}>
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                aria-invalid={emailError !== null}
                aria-describedby={emailError !== null ? 'email-error' : undefined}
                className={`mt-1.5 ${inputClass}`}
                placeholder="you@example.com"
              />
              {emailError !== null && (
                <p id="email-error" className="mt-1 text-sm text-status-failure">
                  {emailError}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="password" className={labelClass}>
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
                aria-invalid={passwordError !== null}
                aria-describedby={passwordError !== null ? 'password-error' : undefined}
                className={`mt-1.5 ${inputClass}`}
                placeholder="••••••••••••"
              />
              {passwordError !== null && (
                <p id="password-error" className="mt-1 text-sm text-status-failure">
                  {passwordError}
                </p>
              )}
            </div>

            <PrimaryButton type="submit" busy={submitting} className="w-full">
              {submitting ? 'Signing in…' : 'Sign in'}
            </PrimaryButton>
          </form>
        </div>

        <div className="mt-6 rounded-xl border border-border-subtle bg-surface p-4 text-xs text-ink-muted">
          <p className="mb-2 font-medium tracking-wide text-ink-faint uppercase">Dev accounts</p>
          <ul className="space-y-1">
            <li>
              <span className="text-ink">admin@example.com</span> / change-me-please — full access
            </li>
            <li>
              <span className="text-ink">reviewer@example.com</span> / reviewer-password — read-only
            </li>
          </ul>
        </div>
      </div>
    </main>
  );
}

/** Only allow same-origin absolute paths as post-login redirects. */
function safeRedirectTarget(search: string): string {
  const next = new URLSearchParams(search).get('next');
  if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
    return next;
  }
  return '/';
}
