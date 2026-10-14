import { describe, it, expect, vi, afterEach } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

/**
 * The production guard in lib/circle/ucw-client.ts runs at MODULE LOAD
 * (`export const circleUcwSdk = buildUcwClient()`), and `next build` imports
 * every route module while collecting page data. So a module-level throw broke
 * the BUILD, not the request:
 *
 *   SECURITY: Production environment detected with CIRCLE_PAYMENTS_MOCK!=0
 *   [Error: Failed to collect page data for /api/admin/treasury/withdraw]
 *
 * docker build cannot supply CIRCLE_PAYMENTS_MOCK: `.env.production` is
 * dockerignored and only NEXT_PUBLIC_* are passed as build args. The guard is a
 * RUNTIME check, so it must stay silent during the build phase and still fire
 * when the server actually starts.
 *
 * These are behavioural: the module is really imported under each environment.
 */

const MODULE = "@/lib/circle/ucw-client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("circleUcwSdk production guard", () => {
  it("does NOT throw while next build is collecting page data", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("CIRCLE_PAYMENTS_MOCK", "");
    await expect(import(MODULE)).resolves.toBeDefined();
  });

  it("still throws at RUNTIME when mock mode is left on in production", async () => {
    // The security intent must survive the fix: a production server with
    // CIRCLE_PAYMENTS_MOCK != "0" is unsafe and must refuse to boot.
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("CIRCLE_PAYMENTS_MOCK", "1");
    await expect(import(MODULE)).rejects.toThrow(/CIRCLE_PAYMENTS_MOCK/);
  });

  it("passes at runtime when CIRCLE_PAYMENTS_MOCK=0", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("CIRCLE_PAYMENTS_MOCK", "0");
    await expect(import(MODULE)).resolves.toBeDefined();
  });
});
