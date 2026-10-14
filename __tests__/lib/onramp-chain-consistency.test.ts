import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The onramp environment and the settlement chain are configured INDEPENDENTLY:
 * `APP_KIT_ENV` picks which Circle environment the onramp talks to (sandbox →
 * Arc testnet, production → Arc mainnet), while `ARC_CHAIN_ID` picks the chain.
 *
 * Nothing links them. Get them out of step and the failure is silent and
 * money-affecting — it looks perfectly healthy right up until funds land on a
 * network the escrow cannot use:
 *
 *   • mainnet chain + sandbox onramp → real cards charged, testnet USDC delivered
 *   • testnet chain + production onramp → mainnet USDC sent to a testnet address
 *
 * These tests pin the guard that makes the mismatch loud.
 *
 * Both modules read env at import time, so each case resets the module registry
 * and re-imports with the env it wants to exercise.
 */

const ORIGINAL = { ...process.env };

/**
 * Raise the per-test timeout for this file only.
 *
 * Each case re-imports the module graph, and the FIRST import has to transform
 * `@circle-fin/app-kit/server` — measured at ~26s on a cold run. Under the 5s
 * default that shows up as a spurious failure on the first `vitest run` after a
 * fresh checkout, and passes on every run after. Not a real regression, but a
 * test that lies on the first run is worse than no test.
 */
vi.setConfig({ testTimeout: 60_000 });

async function loadWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...ORIGINAL };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("@/lib/circle/app-kit");
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("assertOnrampMatchesChain", () => {
  it("accepts testnet chain + sandbox onramp", async () => {
    const m = await loadWith({ ARC_CHAIN_ID: "5042002", APP_KIT_ENV: "sandbox" });
    expect(() => m.assertOnrampMatchesChain()).not.toThrow();
  });

  it("accepts mainnet chain + production onramp", async () => {
    const m = await loadWith({ ARC_CHAIN_ID: "5042", APP_KIT_ENV: "production" });
    expect(() => m.assertOnrampMatchesChain()).not.toThrow();
  });

  it("accepts mainnet chain when APP_KIT_ENV is unset (defaults to production)", async () => {
    const m = await loadWith({ ARC_CHAIN_ID: "5042", APP_KIT_ENV: undefined });
    expect(() => m.assertOnrampMatchesChain()).not.toThrow();
  });

  it("REJECTS mainnet chain + sandbox onramp — real cards, testnet USDC", async () => {
    const m = await loadWith({ ARC_CHAIN_ID: "5042", APP_KIT_ENV: "sandbox" });
    expect(() => m.assertOnrampMatchesChain()).toThrow(/mismatch/i);
  });

  it("REJECTS testnet chain + production onramp — mainnet USDC to a testnet address", async () => {
    const m = await loadWith({ ARC_CHAIN_ID: "5042002", APP_KIT_ENV: "production" });
    expect(() => m.assertOnrampMatchesChain()).toThrow(/mismatch/i);
  });

  it("REJECTS a testnet chain with APP_KIT_ENV unset (silently defaults to production)", async () => {
    // The dangerous default: omitting APP_KIT_ENV on a testnet deploy resolves to
    // "production", which would deliver mainnet USDC to a testnet wallet.
    const m = await loadWith({ ARC_CHAIN_ID: "5042002", APP_KIT_ENV: undefined });
    expect(() => m.assertOnrampMatchesChain()).toThrow(/mismatch/i);
  });

  it("the error says which value to set, so the fix is unambiguous", async () => {
    const m = await loadWith({ ARC_CHAIN_ID: "5042", APP_KIT_ENV: "sandbox" });
    expect(() => m.assertOnrampMatchesChain()).toThrow(/APP_KIT_ENV="production"/);

    const m2 = await loadWith({ ARC_CHAIN_ID: "5042002", APP_KIT_ENV: "production" });
    expect(() => m2.assertOnrampMatchesChain()).toThrow(/APP_KIT_ENV="sandbox"/);
  });
});

/**
 * The App Kit key fallback.
 *
 * The Console issues a SEPARATE key per product, so `APP_KIT_API_KEY` is the
 * right one to use. The code still falls back to `CIRCLE_API_KEY` (which works —
 * verified by minting a real session with it), but that fallback is a silent
 * degradation: a product-scoped key used against the wrong product is rejected
 * by Circle, and the operator would only find out when a user's card fails.
 *
 * So the fallback logs. These tests keep that signal from being dropped.
 */
describe("appServerKit — the API-key fallback is visible, not silent", () => {
  it("warns when APP_KIT_API_KEY is missing", async () => {
    // ORDER MATTERS: `loadWith` calls `vi.resetModules()`, so the logger must be
    // imported AFTER it. Importing first would give the spy a *previous* module
    // instance while app-kit gets a fresh one — the spy would never fire and the
    // test would fail for a reason that has nothing to do with the behaviour.
    const m = await loadWith({
      ARC_CHAIN_ID: "5042002",
      APP_KIT_ENV: "sandbox",
      APP_KIT_API_KEY: undefined,
      CIRCLE_API_KEY: "TEST_API_KEY:fallback-key",
    });
    const { logger } = await import("@/lib/logger");
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    m.appServerKit();

    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0] ?? "")).toMatch(/APP_KIT_API_KEY/);
    spy.mockRestore();
  });

  it("stays quiet when the dedicated key IS set", async () => {
    const m = await loadWith({
      ARC_CHAIN_ID: "5042002",
      APP_KIT_ENV: "sandbox",
      APP_KIT_API_KEY: "TEST_API_KEY:dedicated-key",
      CIRCLE_API_KEY: "TEST_API_KEY:fallback-key",
    });
    const { logger } = await import("@/lib/logger");
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    m.appServerKit();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
