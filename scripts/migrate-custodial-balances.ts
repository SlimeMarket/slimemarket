/**
 * scripts/migrate-custodial-balances.ts
 *
 * Migrate legacy custodial balances (DB wallets.usdc_balance) to real on-chain
 * USDC in each user's UCW via `fundUcwFromTreasury`. Run AFTER F6 contract
 * redeploy + multisig setup + indexer_state reset.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/migrate-custodial-balances.ts --dry-run
 *   node --env-file=.env.local --import tsx scripts/migrate-custodial-balances.ts --limit 10
 *   node --env-file=.env.local --import tsx scripts/migrate-custodial-balances.ts --limit 10 --no-dry-run
 *
 * Idempotent: re-running skips already-migrated rows (status='migrated').
 * Resumable: rows in 'pending' state are re-checked; if the Circle tx is
 * CONFIRMED, they're marked 'migrated'; if FAILED, they're marked 'failed'
 * for manual review.
 *
 * Prerequisites:
 *   - supabase db push 0027-0031 applied
 *   - PLATFORM_CIRCLE_WALLET_ID configured + funded with USDC for migration
 *   - ONCHAIN_WALLET_FUNDS=1
 *   - F6 contract redeployed + multisig treasury set up (so DCW balance is
 *     now a real on-chain balance, not a DB number)
 */
import { createClient } from "@supabase/supabase-js";
import { fundUcwFromTreasury, getOnChainBalanceMicro } from "../lib/wallet/onchain-funding";
import { waitForCircleTxState } from "../lib/wallet/circle-tx-status";

// Parse CLI args.
const args = process.argv.slice(2);
const dryRun = !args.includes("--no-dry-run");
const limitArgIdx = args.indexOf("--limit");
const limit = limitArgIdx >= 0 ? parseInt(args[limitArgIdx + 1] ?? "10", 10) : 10;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

interface WalletRow {
  id: string;
  user_id: string;
  address: string;
  circle_wallet_id: string;
  usdc_balance: string;
  wallet_type: string | null;
  custodial_migrated_at: string | null;
  custodial_migration_tx_id: string | null;
  custodial_migration_status: string | null;
}

async function fetchPendingWallets(limit: number): Promise<WalletRow[]> {
  const { data, error } = await supabase
    .from("wallets")
    .select("id, user_id, address, circle_wallet_id, usdc_balance, wallet_type, custodial_migrated_at, custodial_migration_tx_id, custodial_migration_status")
    .gt("usdc_balance", 0)
    .is("custodial_migrated_at", null)
    .or("custodial_migration_status.is.null,custodial_migration_status.eq.pending")
    .limit(limit);
  if (error) throw new Error(`fetch failed: ${error.message}`);
  return (data ?? []) as WalletRow[];
}

function isEligible(w: WalletRow): { ok: boolean; reason?: string } {
  if (!w.address) return { ok: false, reason: "no on-chain address" };
  if (!w.circle_wallet_id) return { ok: false, reason: "no circle wallet id" };
  if (w.circle_wallet_id.startsWith("mock-") || w.circle_wallet_id.startsWith("dev-")) {
    return { ok: false, reason: "dev/mock wallet" };
  }
  if (w.wallet_type === "dcw") return { ok: false, reason: "DCW (not UCW)" };
  return { ok: true };
}

async function markSkipped(w: WalletRow, reason: string) {
  const { error } = await supabase
    .from("wallets")
    .update({
      custodial_migration_status: "skipped",
    })
    .eq("id", w.id);
  if (error) console.error(`  ! failed to mark ${w.id} as skipped: ${error.message}`);
  console.log(`  ⊘ ${w.id} skipped: ${reason}`);
}

async function markFailed(w: WalletRow, reason: string, txId?: string) {
  const { error } = await supabase
    .from("wallets")
    .update({
      custodial_migration_status: "failed",
      custodial_migration_tx_id: txId ?? null,
    })
    .eq("id", w.id);
  if (error) console.error(`  ! failed to mark ${w.id} as failed: ${error.message}`);
  console.error(`  ✗ ${w.id} failed: ${reason}`);
}

async function markMigrated(w: WalletRow, txId: string) {
  const { error } = await supabase
    .from("wallets")
    .update({
      custodial_migrated_at: new Date().toISOString(),
      custodial_migration_tx_id: txId,
      custodial_migration_status: "migrated",
    })
    .eq("id", w.id);
  if (error) console.error(`  ! failed to mark ${w.id} as migrated: ${error.message}`);
  console.log(`  ✓ ${w.id} migrated (tx ${txId.slice(0, 8)}…, ${w.usdc_balance} micro)`);
}

async function migrateWallet(w: WalletRow): Promise<void> {
  const eligible = isEligible(w);
  if (!eligible.ok) {
    await markSkipped(w, eligible.reason!);
    return;
  }

  // For 'pending' rows (re-run after crash), check the existing tx first.
  if (w.custodial_migration_tx_id && w.custodial_migration_status === "pending") {
    console.log(`  ↻ ${w.id} re-checking pending tx ${w.custodial_migration_tx_id.slice(0, 8)}…`);
    try {
      const state = await waitForCircleTxState(w.custodial_migration_tx_id, { timeoutMs: 30_000 });
      if (state === "CONFIRMED" || state === "COMPLETE") {
        await markMigrated(w, w.custodial_migration_tx_id);
        return;
      } else if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") {
        await markFailed(w, `prior tx terminal-failed: ${state}`, w.custodial_migration_tx_id);
        return;
      } else {
        console.log(`  ⏳ ${w.id} tx still pending (state: ${state ?? "null"}) — will retry next batch`);
        return;
      }
    } catch (e) {
      console.warn(`  ! ${w.id} re-check threw: ${(e as Error).message} — will retry`);
      return;
    }
  }

  // Fresh migration: mark pending, submit fundUcwFromTreasury, await CONFIRMED.
  const amountMicro = BigInt(w.usdc_balance);
  console.log(`  → ${w.id} migrating ${amountMicro.toString()} micro to ${w.address.slice(0, 8)}…`);

  // Mark pending BEFORE submitting so a crash leaves a recoverable state.
  const { error: pendErr } = await supabase
    .from("wallets")
    .update({ custodial_migration_status: "pending" })
    .eq("id", w.id);
  if (pendErr) {
    console.error(`  ! ${w.id} failed to mark pending: ${pendErr.message}`);
    return;
  }

  let txId: string;
  try {
    txId = await fundUcwFromTreasury({ toAddress: w.address, amountMicro });
  } catch (e) {
    await markFailed(w, `fundUcwFromTreasury threw: ${(e as Error).message}`);
    return;
  }

  // Update tx id (in case we crash before confirmation).
  await supabase
    .from("wallets")
    .update({ custodial_migration_tx_id: txId })
    .eq("id", w.id);

  try {
    const state = await waitForCircleTxState(txId, { timeoutMs: 60_000 });
    if (state !== "CONFIRMED" && state !== "COMPLETE") {
      await markFailed(w, `tx not confirmed (state: ${state ?? "timeout"})`, txId);
      return;
    }
    // Verify on-chain balance increased (defense in depth).
    const balance = await getOnChainBalanceMicro(w.address);
    if (balance < amountMicro) {
      // On-chain balance didn't increase as expected — could be a concurrent
      // tx. Flag for manual review.
      await markFailed(w, `on-chain balance (${balance.toString()}) < migrated amount (${amountMicro.toString()})`, txId);
      return;
    }
    await markMigrated(w, txId);
  } catch (e) {
    // Tx may still confirm later — leave as 'pending' for next batch.
    console.error(`  ! ${w.id} confirmation threw: ${(e as Error).message} — left as pending`);
  }
}

async function main() {
  console.log(`\n=== Custodial Balance Migration ===`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE"}`);
  console.log(`Batch limit: ${limit}`);
  console.log(`Supabase URL: ${SUPABASE_URL}\n`);

  const wallets = await fetchPendingWallets(limit);
  console.log(`Found ${wallets.length} wallet(s) to process.\n`);

  if (dryRun) {
    for (const w of wallets) {
      const eligible = isEligible(w);
      const amount = BigInt(w.usdc_balance);
      console.log(
        `  [DRY] ${w.id} user=${w.user_id.slice(0, 8)}… amount=${amount.toString()} micro ` +
        `address=${w.address.slice(0, 10)}… type=${w.wallet_type ?? "?"} ` +
        `status=${w.custodial_migration_status ?? "fresh"} ` +
        `eligible=${eligible.ok}${eligible.reason ? ` (${eligible.reason})` : ""}`
      );
    }
    console.log(`\nDry run complete. Re-run with --no-dry-run to execute.`);
    return;
  }

  let ok = 0, failed = 0;
  for (const w of wallets) {
    try {
      await migrateWallet(w);
      ok++;
    } catch (e) {
      console.error(`  ! ${w.id} unexpected error: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\n=== Batch complete ===`);
  console.log(`Processed: ${wallets.length}`);
  console.log(`OK: ${ok}, Failed: ${failed}`);
  console.log(`\nRun reconcileTreasuryBalance() via /api/admin/reconcile/balance to verify drift.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
