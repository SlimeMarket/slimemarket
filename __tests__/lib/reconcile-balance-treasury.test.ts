import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression: treasury balance reconciliation (lib/reconcile/balance.ts) was
 * permanently wrong, producing a FALSE drift alert every hour.
 *
 *  1. The treasury DCW address was looked up as
 *     `wallets.circle_wallet_id = PLATFORM_CIRCLE_WALLET_ID`. But `wallets`
 *     only holds *user* wallets — the platform treasury is never a row there.
 *     Verified live: that query returns `[]`. So `dcwWallet` was always null,
 *     `dcwOnChainBalanceMicro` was hard-wired to 0, and `drift` came out
 *     negative by the entire treasury balance.
 *
 *  2. Live symptom before the fix:
 *     {"dcwOnChainBalanceMicro":"0","escrowPendingFeesMicro":"80000",
 *      "dbWalletsSumMicro":"0","dbPendingTxsSumMicro":"40000000",
 *      "driftMicro":"-39920000","driftExceedsThreshold":true}
 *     After the fix (and the companion faucet-zombie cleanup):
 *     {"dcwOnChainBalanceMicro":"0","escrowPendingFeesMicro":"80000",
 *      "dbWalletsSumMicro":"0","dbPendingTxsSumMicro":"0",
 *      "driftMicro":"80000","driftExceedsThreshold":false}
 *
 * The treasury address must come from env (same source /api/admin/treasury
 * uses), with a DB lookup kept only as a fallback.
 */
const SRC = fs.readFileSync(
  path.join(process.cwd(), "lib/reconcile/balance.ts"),
  "utf8",
);
// Strip comments so the doc block (which describes the old bug) can't satisfy
// these assertions.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("treasury balance reconciliation", () => {
  it("reads the treasury address from env before falling back to the DB", () => {
    expect(CODE).toMatch(/NEXT_PUBLIC_AGENT_WALLET_ADDRESS/);
    expect(CODE).toMatch(/treasuryAddressFromEnv/);
  });

  it("does NOT rely solely on wallets.circle_wallet_id to find the treasury", () => {
    // The env-first resolution must appear BEFORE the DB fallback, otherwise a
    // user-wallet-only table silently zeroes the whole reconciliation.
    const envIdx = CODE.indexOf("treasuryAddressFromEnv()");
    const dbIdx = CODE.indexOf('from("wallets")');
    expect(envIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeGreaterThan(-1);
    expect(envIdx, "env lookup must precede the DB fallback").toBeLessThan(dbIdx);
  });

  it("warns loudly when the treasury address cannot be resolved", () => {
    // A silent zero is what made this bug invisible for so long.
    expect(CODE).toMatch(/logger\.warn\(/);
    expect(CODE).toMatch(/unresolved/i);
  });

  it("still exposes the drift fields the cron contract depends on", () => {
    for (const field of [
      "dcwOnChainBalanceMicro",
      "escrowPendingFeesMicro",
      "dbWalletsSumMicro",
      "dbPendingTxsSumMicro",
      "driftMicro",
      "driftExceedsThreshold",
    ]) {
      expect(CODE, `missing ${field}`).toContain(field);
    }
  });

  it("computes drift as (chain + escrow) - (wallet ledger + pending txs)", () => {
    expect(CODE).toMatch(
      /dcwOnChainBalanceMicro\s*\+\s*escrowPendingFeesMicro\s*-\s*dbWalletsSumMicro\s*-\s*dbPendingTxsSumMicro/,
    );
  });

  it("reports which money model produced the reading", () => {
    expect(CODE).toMatch(/mode:\s*nonCustodial\s*\?\s*["']non-custodial["']\s*:\s*["']custodial["']/);
    expect(CODE).toMatch(/isNonCustodial/);
    expect(CODE).toMatch(/ONCHAIN_WALLET_FUNDS/);
  });

  it("suppresses the alert in the non-custodial model", () => {
    // In non-custodial mode the treasury is a transit account, so the
    // treasury-vs-ledger comparison is structurally positive (it equals the
    // treasury balance). Alerting on it is permanent noise. Verified live:
    // before → {"driftMicro":"15120000","driftExceedsThreshold":true}
    // after  → {"driftMicro":"15120000","driftExceedsThreshold":false,
    //           "mode":"non-custodial"}
    expect(CODE).toMatch(/nonCustodial\s*\?\s*false/);
  });

  it("keeps drift computed and reported even when the alert is suppressed", () => {
    // Visibility must not be lost — ops still need the number.
    expect(CODE).toMatch(/driftMicro,/);
    expect(CODE).toMatch(/driftMicro,?\s*$/m);
  });
});
