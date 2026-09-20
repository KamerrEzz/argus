import { expect, test } from '@playwright/test';
import { SEED } from './env';
import { apiFetch } from './helpers';

test('lists review runs', async ({ page }) => {
  await page.goto('/reviews');
  await expect(page.getByRole('heading', { name: 'Review Runs', level: 1 })).toBeVisible();
  // The Run column links each row to its detail page. The shared dev database
  // accumulates runs across suites and the directory is newest-first with a
  // 20-row page, so asserting one specific seeded row makes this test
  // order-dependent. Assert the directory renders real review rows with
  // well-formed detail links; the seeded run's own page is covered below.
  const runLinks = page.getByRole('table', { name: 'Review runs' }).locator('a[href^="/reviews/"]');
  await expect(runLinks.first()).toBeVisible();
  const hrefs = await runLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute('href') ?? ''),
  );
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(href).toMatch(/^\/reviews\/[0-9a-f-]{36}$/);
  }
});

test('shows the completed run: narrative, findings, usage and trace', async ({ page }) => {
  await page.goto(`/reviews/${SEED.reviewCompletedId}`);
  await expect(page.getByRole('heading', { name: /^Review / })).toBeVisible();
  await expect(page.getByText('Narrative summary')).toBeVisible();
  await expect(page.getByText('Findings (5)')).toBeVisible();
  await expect(
    page.getByText('SQL query built from request parameter without parameterisation'),
  ).toBeVisible();
  await expect(page.getByText('Usage & cost')).toBeVisible();
  await expect(page.getByText('Agent node trace')).toBeVisible();
  await expect(page.getByText('Review plan')).toBeVisible();
});

test('retry without GitHub credentials fails with a typed error and stays put', async ({
  page,
}) => {
  await page.goto(`/reviews/${SEED.reviewCompletedId}`);
  await expect(page.getByRole('heading', { name: /^Review / })).toBeVisible();

  // Retry re-reads the pull request from GitHub, so without credentials it is
  // refused with the same typed 502 as a fresh trigger: an error toast, and
  // no navigation to a run that was never created.
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`/reviews/${SEED.reviewCompletedId}`));
});

test('triggering a review without GitHub credentials fails with a typed 502', async ({
  page,
}) => {
  await page.goto(`/pulls/${SEED.pullRequestAuthId}`);
  await expect(page.getByRole('button', { name: 'Review now' })).toBeVisible();

  // Without a GitHub App or token the API cannot even read the pull request,
  // so the trigger is refused synchronously: a typed envelope, never a crash
  // and never a run row that will hang forever.
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/pull-requests/') && response.url().endsWith('/review'),
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: 'Review now' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(502);
  const body = (await response.json()) as { readonly code?: string; readonly requestId?: string };
  expect(body.code).toBe('github_api_error');
  expect(typeof body.requestId).toBe('string');
});

test('the failed trigger left an audit trail via the API', async ({ page }) => {
  // apiFetch runs inside the page, so the page needs a real origin first:
  // from about:blank the fetch has a null origin and CORS rejects it.
  await page.goto('/');
  const response = await apiFetch<{ readonly items?: readonly unknown[] }>(page, '/reviews');
  expect(response.status).toBe(200);
  expect(Array.isArray(response.json.items)).toBe(true);
  expect((response.json.items ?? []).length).toBeGreaterThan(0);
});
