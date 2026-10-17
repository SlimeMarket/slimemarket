import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `CIRCLE_USDC_TOKEN_ID` in production was the all-zero placeholder UUID, and
 * every UCW transfer failed with Circle's opaque "API parameter invalid" —
 * surfaced to the user as `Send failed: API parameter invalid` on /wallet.
 *
 * These tests pin the guard: a placeholder must never be forwarded to Circle,
 * and a real id must be used as-is.
 */

const ORIGINAL = { ...process.env };
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

// Each case re-imports the module graph (lib/arc → viem). The FIRST import on a
// cold cache can take seconds, which shows up as a spurious timeout — a test
// that lies on the first run is worse than no test.
vi.setConfig({ testTimeout: 60_000 });

async function loadWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...ORIGINAL };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("@/lib/circle/usdc-token");
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("usdc token id resolution", () => {
  it("flags the all-zero placeholder as missing", async () => {
    const { isPlaceholderTokenId } = await loadWith({ CIRCLE_USDC_TOKEN_ID: PLACEHOLDER });
    expect(isPlaceholderTokenId(PLACEHOLDER)).toBe(true);
    expect(isPlaceholderTokenId("")).toBe(true);
    expect(isPlaceholderTokenId(undefined)).toBe(true);
    expect(isPlaceholderTokenId("5677d668-490d-51d3-82c7-b2b8313df2f4")).toBe(false);
  });

  it("throws instead of sending the placeholder to Circle", async () => {
    const { resolveUsdcTokenId } = await loadWith({
      CIRCLE_USDC_TOKEN_ID: PLACEHOLDER,
      // no wallet id → no balances lookup, so this is the env-only path
      CIRCLE_API_KEY: undefined,
    });
    await expect(resolveUsdcTokenId()).rejects.toThrow(/token id is not configured/i);
  });

  it("returns a real configured token id", async () => {
    const real = "5677d668-490d-51d3-82c7-b2b8313df2f4";
    const { resolveUsdcTokenId } = await loadWith({
      CIRCLE_USDC_TOKEN_ID: real,
      CIRCLE_API_KEY: undefined,
    });
    await expect(resolveUsdcTokenId()).resolves.toBe(real);
  });
});
