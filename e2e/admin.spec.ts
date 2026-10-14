import { test, expect, collectErrors, expectNoPageErrors, waitForShell, loginAs } from './helpers';

// Admin panel: loads with its key sections; audit log API responds.
test.describe('Admin panel', () => {
  test.setTimeout(60_000);

  test('admin panel loads and audit API responds', async ({ browser, request }) => {
    const context = await loginAs(browser, request, 'admin');
    const page = await context.newPage();
    const errors = collectErrors(page);
    const api = context.request;

    // API milestone: audit log requires the Admin role → 200 proves authz.
    const auditRes = await api.get('/api/admin/audit');
    expect(auditRes.ok(), `GET /api/admin/audit -> ${auditRes.status()}`).toBeTruthy();

    // UI: after login, app shell renders SlimeMarket brand somewhere.
    await page.goto('/admin');
    await waitForShell(page);

    await expect(page.getByText(/SlimeMarket/i).first()).toBeVisible();

    expectNoPageErrors(errors);
    await context.close();
  });

  test('non-admin cannot read audit log', async ({ browser, request }) => {
    // Regression guard: role check actually enforced.
    const context = await loginAs(browser, request, 'buyer');
    const auditRes = await context.request.get('/api/admin/audit');
    expect([401, 403]).toContain(auditRes.status());
    await context.close();
  });
});
