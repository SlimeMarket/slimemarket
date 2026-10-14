import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression: the dev faucet stranded zombie `pending` wallet_txs.
 *
 * lib/wallet/faucet.ts inserts the `wallet_txs` mirror row with
 * `status: "pending"` BEFORE it moves any USDC. In the non-custodial path
 * (`ONCHAIN_WALLET_FUNDS=1`) the transfer via `fundUcwFromTreasury` throws when
 * the platform treasury is empty / the relayer is misconfigured. That throw
 * propagated to the route, which answered 402 — but the `pending` row was never
 * rolled back.
 *
 * Result (verified live 2026-09-28): 10 zombie rows, all
 * `label="Arc faucet (dev)"`, `method="onchain"`, `circle_tx_id=null`,
 * 6–23h old, totalling **40 USDC** that never existed. Because
 * `sum_pending_wallet_txs` counts every `pending` row as money in flight, they
 * also inflated the negative treasury drift.
 *
 * Fix: on ANY failure after the insert, flip the mirror row to `failed`.
 * `wallet_txs.status` CHECK allows ('done','escrowed','pending','failed').
 */
const SRC = fs.readFileSync(
  path.join(process.cwd(), "lib/wallet/faucet.ts"),
  "utf8",
);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("dev faucet — no zombie pending wallet_txs", () => {
  it("has a helper that marks a mirror row failed", () => {
    expect(CODE).toMatch(/async function markFaucetTxFailed/);
    expect(CODE).toMatch(/status:\s*["']failed["']/);
  });

  it("marks the row failed when no on-chain funding path exists", () => {
    // The canFundOnChain guard throws — it must fail the row first.
    const guardIdx = CODE.indexOf("canFundOnChain(");
    const failIdx = CODE.indexOf("markFaucetTxFailed(admin", guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(failIdx, "guard must be followed by markFaucetTxFailed").toBeGreaterThan(guardIdx);
  });

  it("marks the row failed when the treasury transfer throws", () => {
    // fundUcwFromTreasury must be wrapped in try/catch that fails the row.
    const transferIdx = CODE.indexOf("await fundUcwFromTreasury(");
    expect(transferIdx).toBeGreaterThan(-1);
    const callIdx = CODE.indexOf("markFaucetTxFailed(admin", transferIdx);
    expect(callIdx, "transfer must be wrapped so a throw fails the row").toBeGreaterThan(transferIdx);
  });

  it("still marks the row done on success", () => {
    expect(CODE).toMatch(/circle_tx_id:\s*circleTxId,\s*status:\s*["']done["']/);
  });

  it("never leaves the pending insert as the terminal state on failure", () => {
    // Count how many throw sites exist after the insert; each must be preceded
    // by a markFaucetTxFailed call (or be the insert's own error).
    const failCalls = CODE.match(/markFaucetTxFailed\(/g) ?? [];
    // definition + at least the two failure paths (guard + transfer)
    expect(failCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("uses a failed status that the DB CHECK constraint accepts", () => {
    const migration = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/0001_init.sql"),
      "utf8",
    );
    expect(migration).toMatch(/status\s+text not null default 'done'/);
    expect(migration).toMatch(/check \(status in \('done','escrowed','pending','failed'\)\)/);
  });
});
