import { test as base, expect } from '@playwright/test';
import type { Browser, BrowserContext, APIRequestContext, Page, TestInfo } from '@playwright/test';

/**
 * Shared e2e helpers for the SlimeMarket SPA.
 *
 * Selector strategy: the UI is a Babel-in-browser React SPA served from
 * public/*.jsx — first paint compiles JSX in the browser, so every spec gets
 * generous timeouts (60s test timeout, expect defaults 10s) and should rely
 * on getByRole / getByText with visible-text assertions rather than pixel
 * coordinates or brittle CSS. When a flow is fragile in the UI (multi-step
 * checkout), assert the milestone via the JSON API through the logged-in
 * request context instead.
 *
 * No dotenv here: Next loads `.env.local` itself for `npm run dev`; the only
 * env playwright needs is E2E_BASE_URL (handled in playwright.config.ts).
 */

/**
 * Seeded test accounts per docs/TESTING.md. Overridable via env for local
 * runs against a different DB: E2E_BUYER_EMAIL / E2E_SELLER_EMAIL /
 * E2E_ADMIN_EMAIL (roles stay fixed — dev-login enforces them).
 */
export const ACCOUNTS = {
  buyer: {
    email: process.env.E2E_BUYER_EMAIL || 'testbuyer@slimemarket.app',
    role: 'Buyer',
  },
  seller: {
    email: process.env.E2E_SELLER_EMAIL || 'testseller@slimemarket.app',
    role: 'Seller',
  },
  admin: {
    email: process.env.E2E_ADMIN_EMAIL || 'rimuru@slimemarket.app',
    role: 'Admin',
  },
} as const;

export type AccountKey = keyof typeof ACCOUNTS;

/**
 * Dev-login (bypasses Circle OTP, dev-only endpoint) and return a
 * BrowserContext carrying the session cookies.
 *
 * POST /api/auth/dev-login sets httpOnly cookies (circle_user_token,
 * circle_email, circle_encryption_key). We POST through Playwright's API
 * request context, harvest the set-cookie headers, and hand them to a fresh
 * browser context via storageState.
 */
export async function loginAs(
  browser: Browser,
  request: APIRequestContext,
  account: AccountKey | { email: string; role: string },
): Promise<BrowserContext> {
  const acc = typeof account === 'string' ? ACCOUNTS[account] : account;
  const resp = await request.post('/api/auth/dev-login', {
    data: { email: acc.email, role: acc.role },
  });
  if (!resp.ok()) {
    throw new Error(`dev-login failed for ${acc.email}: HTTP ${resp.status()} — ${await resp.text().catch(() => '')}`);
  }

  const cookies = resp
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => parseSetCookie(h.value));

  if (cookies.length === 0) {
    throw new Error(`dev-login for ${acc.email} returned no set-cookie headers`);
  }

  const context = await browser.newContext({
    storageState: { cookies, origins: [] },
  });
  // Reuse the same request pipeline inside the context for API assertions.
  return context;
}

function parseSetCookie(raw: string): {
  name: string; value: string; domain: string; path: string;
  expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None';
} {
  const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  const cookie: ReturnType<typeof parseSetCookie> = {
    name,
    value,
    domain: 'localhost',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  };
  for (const attr of attrs) {
    const [k, v] = attr.split('=').map((s) => s.trim());
    const key = k.toLowerCase();
    if (key === 'domain' && v) cookie.domain = v.replace(/^\./, '');
    else if (key === 'path' && v) cookie.path = v;
    else if (key === 'expires' && v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000);
    } else if (key === 'max-age' && v) {
      const s = parseInt(v, 10);
      if (!Number.isNaN(s)) cookie.expires = Math.floor(Date.now() / 1000) + s;
    } else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite' && v) {
      cookie.sameSite = ({ strict: 'Strict', lax: 'Lax', none: 'None' } as const)[
        v.toLowerCase() as 'strict' | 'lax' | 'none'
      ] ?? 'Lax';
    }
  }
  return cookie;
}

/** Console/page-error collector. Fails the test on uncaught page errors. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore noisy dev-mode / third-party chatter that is not app breakage.
      if (/Download the React DevTools|favicon/i.test(text)) return;
      // The SPA fires authed background fetches (auth/me, chats, orders,
      // wallet) at boot. On an UNAUTHENTICATED public-page visit those
      // legitimately return 401 and the SPA falls back to guest mode. That is
      // an expected resource-load failure, not app breakage. Genuine problems
      // still surface via pageerror and any other console error.
      if (/Failed to load resource.*(401|403)/i.test(text)) return;
      // A DEGRADED /api/health returns 503 by design while the escrow indexer
      // is catching up (or Redis is absent in local mock) — the SPA logs the
      // failed fetch. That is a normal local state, not app breakage.
      const url = msg.location()?.url ?? "";
      if (/\/api\/health/.test(url) && /503/.test(text)) return;
      errors.push(`console: ${text}`);
    }
  });
  return errors;
}

/** Assert no uncaught page errors were collected (call at end of test). */
export function expectNoPageErrors(errors: string[]): void {
  expect(errors, errors.join('\n')).toHaveLength(0);
}

/**
 * Wait until the SPA shell has rendered (Babel-in-browser first paint can be
 * slow). Uses visible body text rather than networkidle, which never settles
 * for polling SPAs.
 */
export async function waitForShell(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  // The SPA mounts into #root; wait for any meaningful rendered text.
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root');
      return !!root && (root.innerText || '').trim().length > 20;
    },
    undefined,
    { timeout: 45_000 },
  );
}

/** Convenience: fresh context + page logged in as the given account. */
export async function loggedInPage(
  browser: Browser,
  request: APIRequestContext,
  account: AccountKey,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await loginAs(browser, request, account);
  const page = await context.newPage();
  return { context, page };
}

export { base as test, expect };
