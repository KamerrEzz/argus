import { expect, test } from '@playwright/test';

test('lists the seeded repositories', async ({ page }) => {
  await page.goto('/repositories');
  await expect(page.getByRole('heading', { name: 'Repositories', level: 1 })).toBeVisible();
  await expect(page.getByText('acme/api-gateway')).toBeVisible();
  await expect(page.getByText('acme/web-console')).toBeVisible();
});

test('searches repositories by name', async ({ page }) => {
  await page.goto('/repositories');
  await page.getByPlaceholder('Search owner/name…').fill('web-console');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('acme/web-console')).toBeVisible();
  await expect(page.getByText('acme/api-gateway')).toHaveCount(0);
});

test('shows repository detail with policy, access and trigger sections', async ({ page }) => {
  await page.goto('/repositories');
  await page.getByText('acme/api-gateway').click();
  await expect(page.getByRole('heading', { name: 'acme/api-gateway' })).toBeVisible();
  await expect(page.getByText('Review policy')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible();
  await expect(page.getByText('Access management')).toBeVisible();
  await expect(page.getByText('Trigger a review')).toBeVisible();
  await expect(page.getByText('Recent activity')).toBeVisible();
});

test('toggles a policy switch and persists it', async ({ page }) => {
  await page.goto('/repositories');
  await page.getByText('acme/api-gateway').click();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible();

  const lintToggle = page.getByRole('switch', { name: 'Run lint' });
  await expect(lintToggle).toBeVisible();
  const before = await lintToggle.isChecked();
  await lintToggle.click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  // Success toast (role=status); the error path would surface role=alert instead.
  await expect(page.getByRole('status').filter({ hasText: /saved|updated|success/i }).first()).toBeVisible({
    timeout: 15_000,
  });

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Run lint' })).toBeVisible();
  expect(await page.getByRole('switch', { name: 'Run lint' }).isChecked()).toBe(!before);

  // Restore the original value so reruns and other specs see stable state.
  await page.getByRole('switch', { name: 'Run lint' }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: /saved|updated|success/i }).first()).toBeVisible({
    timeout: 15_000,
  });
});
