import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e config for SlimeMarket.
 *
 * Notes:
 * - No dotenv loading here: the app's real env lives in `.env.local`, which
 *   Next.js loads automatically for `npm run dev` (the webServer below).
 *   Playwright itself only needs E2E_BASE_URL, which can be set inline
 *   (e.g. `E2E_BASE_URL=http://host:3000 npx playwright test`).
 * - The webServer url points at /api/health (app/api/health/route.ts) so
 *   Playwright waits until the dev server is actually serving.
 * - Serialized execution (workers: 1, fullyParallel: false): all specs share a
 *   single dev server + the same seeded Supabase test accounts, so running
 *   them in parallel would race on shared DB state (orders, balances).
 *
 * ALREADY HAVE A SERVER RUNNING? Set E2E_NO_SERVER=1.
 *   The webServer block below otherwise tries to spawn its own `npm run dev`
 *   and, when something is already bound to the port, loses the startup race
 *   with "EADDRINUSE :::3000". With the flag set, Playwright talks straight to
 *   whatever is listening on E2E_BASE_URL (a dev server, a PM2 stack, staging).
 *
 *     npx playwright test                      # manages its own dev server
 *     E2E_NO_SERVER=1 npx playwright test      # uses the running one
 */

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const manageServer = process.env.E2E_NO_SERVER !== '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(manageServer
    ? {
        webServer: {
          command: `npm run dev -- -p ${new URL(BASE_URL).port || 3000}`,
          // Probe the SAME base URL the specs hit, so an externally-started dev
          // server (reuseExistingServer) on a custom port is detected correctly.
          url: `${BASE_URL}/api/health`,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }
    : {}),
});
