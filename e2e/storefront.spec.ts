import { test, expect, collectErrors, expectNoPageErrors, waitForShell } from './helpers';

// Home + catalog + product detail + language switcher.
test.describe('Storefront', () => {
  test.setTimeout(60_000);

  test('home loads with brand and hero', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForShell(page);

    // Title/brand comes from the SPA shell (SlimeMarket).
    await expect(page.getByText(/SlimeMarket/i).first()).toBeVisible();
    // Hero text (EN default).
    await expect(
      page.getByText(/Buy digital assets without fear of scams/i).first(),
    ).toBeVisible();

    expectNoPageErrors(errors);
  });

  test('product grid renders at least one product', async ({ page, request }) => {
    const errors = collectErrors(page);

    // API sanity: catalog is fetch-backed and non-empty.
    const apiRes = await request.get('/api/products');
    expect(apiRes.ok(), `GET /api/products -> ${apiRes.status()}`).toBeTruthy();
    const body = await apiRes.json();
    const items = body?.data?.items ?? body?.items ?? [];
    expect(items.length).toBeGreaterThan(0);

    await page.goto('/explore');
    await waitForShell(page);
    // Product cards render a "Buy" button each; wait for at least one.
    await expect(page.getByRole('button', { name: /buy/i }).first()).toBeVisible();

    expectNoPageErrors(errors);
  });

  test('navigation to product detail works', async ({ page, request }) => {
    const errors = collectErrors(page);

    const apiRes = await request.get('/api/products');
    const body = await apiRes.json();
    const items = body?.data?.items ?? body?.items ?? [];
    // Explore hides soldout products — pick the first ACTIVE one or
    // the click target would be filtered out of the grid.
    const product = items.find((p: { status?: string }) => p.status === 'active') ?? items[0];
    expect(product).toBeTruthy();
    const productTitle = product.title ?? product.name;

    await page.goto('/explore');
    await waitForShell(page);
    // Click the product card into its detail view (title text is clickable).
    await page.getByText(productTitle, { exact: false }).first().click();
    // Detail view shows a "Buy Now" button and the product title.
    await expect(page.getByRole('button', { name: /buy now/i })).toBeVisible();
    await expect(page.getByText(productTitle, { exact: false }).first()).toBeVisible();

    expectNoPageErrors(errors);
  });

  test('language switcher changes visible text', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForShell(page);

    await expect(
      page.getByText(/Buy digital assets without fear of scams/i).first(),
    ).toBeVisible();

    // Switcher buttons are labeled ENG | ID | 中 | RU.
    await page.getByRole('button', { name: 'ID', exact: true }).click();
    await expect(
      page.getByText(/Beli aset digital tanpa takut scam/i).first(),
    ).toBeVisible();

    // Switch back so other tests/state are unaffected.
    await page.getByRole('button', { name: 'ENG', exact: true }).click();
    await expect(
      page.getByText(/Buy digital assets without fear of scams/i).first(),
    ).toBeVisible();

    expectNoPageErrors(errors);
  });
});
