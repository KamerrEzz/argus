import { expect, test } from '@playwright/test';
import { SEED } from './env';
import { createAwaitingRun } from './helpers';

test('shows the empty state for a run that was never gated', async ({ page }) => {
  await page.goto(`/reviews/${SEED.reviewFailedId}/approvals`);
  await expect(page.getByRole('heading', { name: /^Approvals · review / })).toBeVisible();
  await expect(page.getByText('Nothing waiting on you.')).toBeVisible();
  await expect(
    page.getByText('No approval was ever requested for this run.'),
  ).toBeVisible();
});

test('rejects a pending approval and cancels the run', async ({ page }) => {
  const { runId } = await createAwaitingRun('reject');
  await page.goto(`/reviews/${runId}/approvals`);

  await expect(page.getByText('1 approval(s) awaiting a decision')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Record a decision' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Nothing waiting on you.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('rejected', { exact: true }).first()).toBeVisible();
});

test('approving without GitHub credentials fails gracefully and stays pending', async ({ page }) => {
  const { runId } = await createAwaitingRun('approve');
  await page.goto(`/reviews/${runId}/approvals`);
  await expect(page.getByText('1 approval(s) awaiting a decision')).toBeVisible();

  // The snapshot cannot reach GitHub without credentials, but the page must
  // surface the failure as a toast — not a hang, not a blank screen.
  await page.getByRole('button', { name: 'Approve & publish' }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('1 approval(s) awaiting a decision')).toBeVisible();
});
