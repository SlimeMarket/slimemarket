import { describe, expect, it } from "vitest";
import { bigintReplacer, jsonOk, jsonError } from "@/lib/utils";

/**
 * Regression: viem/escrow reads return `bigint` (micro-USDC, block numbers).
 * `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`
 * unless a replacer converts them — this broke
 * `POST /api/admin/reconcile/balance` with HTTP 500.
 */
describe("jsonOk / jsonError are BigInt-safe", () => {
  it("serializes a top-level bigint as a decimal string", () => {
    expect(JSON.stringify({ v: 123n }, bigintReplacer)).toBe('{"v":"123"}');
  });

  it("serializes nested and array bigints", () => {
    const payload = { a: [1n, 2n], b: { c: 3n }, d: "x" };
    expect(JSON.stringify(payload, bigintReplacer)).toBe(
      '{"a":["1","2"],"b":{"c":"3"},"d":"x"}'
    );
  });

  it("leaves non-bigint values untouched", () => {
    expect(JSON.stringify({ n: 1, s: "a", b: true, z: null }, bigintReplacer)).toBe(
      '{"n":1,"s":"a","b":true,"z":null}'
    );
  });

  it("preserves precision beyond Number.MAX_SAFE_INTEGER", () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    expect(JSON.stringify({ big }, bigintReplacer)).toBe('{"big":"9007199254740993"}');
    // Number() would round it:
    expect(Number(big)).toBe(9_007_199_254_740_992);
  });

  it("jsonOk returns a response whose body is valid JSON for bigint input", async () => {
    const res = jsonOk({ dcwOnChainBalanceMicro: 1_020_000n, driftMicro: -3n });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      dcwOnChainBalanceMicro: "1020000",
      driftMicro: "-3",
    });
  });

  it("jsonError is BigInt-safe too", async () => {
    const res = jsonError("boom", 500, { limit: 10n });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "boom", limit: "10" });
  });
});
