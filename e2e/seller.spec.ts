import { test, expect, collectErrors, expectNoPageErrors, waitForShell, loginAs } from './helpers';

// Seller dashboard: API responds with products; UI shows app shell.
test.describe('Seller', () => {
  test.setTimeout(60_000);

  test('seller dashboard loads with products', async ({ browser, request }) => {
    const context = await loginAs(browser, request, 'seller');
    const page = await context.newPage();
    const errors = collectErrors(page);
    const api = context.request;

    // API milestone: GET /api/my/products works for authenticated seller.
    const prodRes = await api.get('/api/my/products');
    expect(prodRes.ok(), `GET /api/my/products -> ${prodRes.status()}`).toBeTruthy();
    const prodBody = await prodRes.json();
    expect(Array.isArray(prodBody?.items)).toBeTruthy();

    // UI: after login, app shell renders SlimeMarket brand somewhere.
    await page.goto('/seller');
    await waitForShell(page);

    // Basic sanity: any meaningful text from the SPA.
    await expect(page.getByText(/SlimeMarket/i).first()).toBeVisible();

    expectNoPageErrors(errors);
    await context.close();
  });
});
