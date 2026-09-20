import { expect, test } from '@playwright/test';
import { SEED } from './env';

test('lists pull requests', async ({ page }) => {
  await page.goto('/pulls');
  await expect(page.getByRole('heading', { name: 'Pull Requests', level: 1 })).toBeVisible();
  await expect(page.getByPlaceholder('Search title or author…')).toBeVisible();
});

test('shows pull request detail with review history and actions', async ({ page }) => {
  await page.goto(`/pulls/${SEED.pullRequestSqlId}`);
  await expect(page.getByRole('heading', { name: /#128 / })).toBeVisible();
  await expect(page.getByText('Review history')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review now' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync from GitHub' })).toBeVisible();
});

test('returns to the list from a detail page', async ({ page }) => {
  await page.goto(`/pulls/${SEED.pullRequestAuthId}`);
  await expect(page.getByRole('heading', { name: /#57 / })).toBeVisible();
  // The sidebar stays mounted across client navigation.
  await page.getByRole('link', { name: 'Pull Requests' }).click();
  await expect(page.getByRole('heading', { name: 'Pull Requests', level: 1 })).toBeVisible();
});
