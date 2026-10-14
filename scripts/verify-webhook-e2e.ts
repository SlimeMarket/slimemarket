/**
 * End-to-end verification of the escrow webhook pipeline.
 *
 * Proves the WHOLE chain works, not just the pieces:
 *
 *   MarketEscrow emits an event
 *     → Circle SCP event monitor matches it
 *       → Circle POSTs a `contracts.eventLog` webhook
 *         → cloudflared tunnel (or the deployed origin)
 *           → POST /api/webhooks/escrow (signature verified, topics/data decoded)
 *             → a row lands in `webhook_events`
 *
 * WHY `collectFees()`: it is the cheapest way to emit a MONITORED event. It does
 * NOT revert when `pendingFees == 0` — it transfers 0 and still emits
 * `FeesCollected(treasury, 0)` — and it only requires `msg.sender == treasury`,
 * which is the platform DCW. So we can generate a real, signed, on-chain event
 * without running a full checkout.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/verify-webhook-e2e.ts
 *   ... --timeout 120     # seconds to wait for the webhook (default 90)
 *
 * Exit code 0 = webhook received, 1 = it did not arrive (with diagnostics).
 */
import { collectFeesOnChain, readEscrowStats } from "@/lib/contracts/escrow-client";
import { circleDeveloperSdk } from "@/lib/circle/client";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

const args = process.argv.slice(2);
const tIdx = args.indexOf("--timeout");
const TIMEOUT_S = tIdx !== -1 ? Number(args[tIdx + 1]) || 90 : 90;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string, hint?: string): never {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// ---- 0. preflight ---------------------------------------------------------
const stats = await readEscrowStats();
console.log("Escrow state:");
console.log(`  pendingFees  : ${stats.pendingFees}`);
console.log(`  orderCounter : ${stats.orderCounter}`);
console.log(`  paused       : ${stats.paused}`);

const admin = supabaseAdminClient();
const { count: before } = await admin
  .from("webhook_events")
  .select("*", { count: "exact", head: true });
console.log(`  webhook_events rows: ${before ?? 0}`);

// ---- 1. emit a real event -------------------------------------------------
console.log("\n1) Triggering on-chain event (collectFees → FeesCollected) ...");
const tx = await collectFeesOnChain();
if (!tx?.id) {
  fail(
    "collectFeesOnChain did not return a tx id.",
    "Check ESCROW_CONTRACT_ADDRESS / PLATFORM_CIRCLE_WALLET_ID / CIRCLE_* in .env.local",
  );
}
console.log(`   Circle tx id: ${tx.id} (state ${tx.state})`);

// ---- 2. wait for the on-chain hash ---------------------------------------
console.log("\n2) Waiting for the transaction to mine ...");
let txHash: string | null = null;
for (let i = 0; i < 40; i++) {
  const res = await circleDeveloperSdk!.getTransaction({ id: tx.id });
  const t = res.data?.transaction;
  if (t?.state === "COMPLETE" || t?.state === "CONFIRMED") {
    txHash = t.txHash ?? null;
    break;
  }
  if (t?.state === "FAILED" || t?.state === "CANCELLED" || t?.state === "DENIED") {
    fail(`transaction failed: ${t.state} ${t.errorReason ?? ""}`);
  }
  await sleep(3000);
}
if (!txHash) fail("transaction did not mine within ~2 minutes.");
console.log(`   txHash: ${txHash}`);

// ---- 3. wait for the webhook ---------------------------------------------
console.log(`\n3) Waiting for the webhook (max ${TIMEOUT_S}s) ...`);
let found: { notification_type: string; mapped_status: string | null; created_at: string } | null =
  null;

for (let i = 0; i < TIMEOUT_S / 3; i++) {
  const { data } = await admin
    .from("webhook_events")
    .select("notification_type, mapped_status, created_at")
    .eq("circle_transaction_id", txHash)
    .maybeSingle();
  if (data) {
    found = data;
    break;
  }
  process.stdout.write(".");
  await sleep(3000);
}
process.stdout.write("\n");

// ---- 4. verdict -----------------------------------------------------------
if (!found) {
  fail(
    `Webhook NOT received within ${TIMEOUT_S}s.`,
    [
      "Diagnosis:",
      "  1. Subscription exists & enabled?  node scripts/setup-webhook-subscription.mjs --list",
      "  2. Public endpoint reachable?      curl -I <endpoint>   (must be 200)",
      "  3. Tunnel still running?           check the terminal running scripts/tunnel.sh",
      "  4. Event monitor registered?       npm run monitors:list",
      "  5. View logs:                      tail -40 .secrets/tunnel.log",
    ].join("\n  "),
  );
}

console.log("\n✓ WEBHOOK RECEIVED — end-to-end pipeline works.");
console.log(`  notification_type : ${found.notification_type}`);
console.log(`  mapped_status     : ${found.mapped_status ?? "(empty — normal for FeesCollected)"}`);
console.log(`  created_at        : ${found.created_at}`);
console.log(`  txHash            : ${txHash}`);
console.log(
  "\n  Meaning: Circle monitor → subscription → tunnel → /api/webhooks/escrow\n" +
    "  → signature verification → decode topics/data → webhook_events. All working.",
);
process.exit(0);
