import { test as setup } from '@playwright/test';
import { loginAs } from './helpers';

const ADMIN_STATE = 'playwright/.auth/admin.json';

// One login for the whole suite: the login endpoint is rate-limited
// (10/min), so per-test logins would throttle the suite itself.
setup('authenticate as admin', async ({ page }) => {
  await loginAs(page);
  await page.context().storageState({ path: ADMIN_STATE });
});
