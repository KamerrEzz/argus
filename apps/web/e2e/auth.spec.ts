import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env';
import { loginAs } from './helpers';

// These tests drive the login form itself, so they must not inherit the
// suite-wide authenticated session from the setup project.
test.use({ storageState: { cookies: [], origins: [] } });

test('redirects unauthenticated visitors to login', async ({ page }) => {
  await page.goto('/repositories');
  await page.waitForURL('**/login**', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('rejects wrong credentials with an alert and stays on login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('validates empty fields without touching the API', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Email is required')).toBeVisible();
});

test('signs in as admin and lands on the dashboard', async ({ page }) => {
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Repositories' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review Runs' })).toBeVisible();
});
