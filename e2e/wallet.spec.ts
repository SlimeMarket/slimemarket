import { test, expect, collectErrors, expectNoPageErrors, waitForShell, loginAs } from './helpers';

// Wallet / balance page: loads after login; API responds.
test.describe('Wallet (balance)', () => {
  test.setTimeout(60_000);

  test('wallet endpoint responds', async ({ browser, request }) => {
    const context = await loginAs(browser, request, 'buyer');
    const page = await context.newPage();
    const errors = collectErrors(page);
    const api = context.request;

    // API milestone: wallet endpoint responds for the logged-in user.
    const walletRes = await api.get('/api/wallet');
    expect(walletRes.ok(), `GET /api/wallet -> ${walletRes.status()}`).toBeTruthy();

    // UI: /wallet view shows app shell after auth.
    await page.goto('/wallet');
    await waitForShell(page);

    await expect(page.getByText(/SlimeMarket/i).first()).toBeVisible();

    expectNoPageErrors(errors);
    await context.close();
  });
});
