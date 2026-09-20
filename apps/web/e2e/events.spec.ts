import { expect, test } from '@playwright/test';
import { SEED } from './env';
import { publishProbeEvent } from './helpers';

test('connects the stream and shows the empty state', async ({ page }) => {
  await page.goto(`/reviews/${SEED.reviewFailedId}/events`);
  await expect(page.getByRole('heading', { name: 'Live review events' })).toBeVisible();
  await expect(page.getByText('Stream connected')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Waiting for events…')).toBeVisible();
});

test('streams a freshly published probe event live', async ({ page }) => {
  const message = `e2e-probe-${Date.now()}`;
  await page.goto(`/reviews/${SEED.reviewCompletedId}/events`);
  await expect(page.getByText('Stream connected')).toBeVisible({ timeout: 20_000 });

  await publishProbeEvent(SEED.reviewCompletedId, message);
  await expect(page.getByText(message)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('node.started').first()).toBeVisible();
});
