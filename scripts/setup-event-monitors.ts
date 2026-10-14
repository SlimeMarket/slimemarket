/**
 * Register (and optionally prune) Circle SCP event monitors for MarketEscrow.
 *
 * WHY: the escrow indexer currently POLLS the chain every minute (cron
 * `* * * * *` → /api/admin/indexer/run). With event monitors, Circle pushes a
 * `contracts.eventLog` webhook the moment an event lands, so the polling cron
 * (plus the 3 reconcile crons that exist to repair polling drift) can go away.
 *
 * ⚠️ SIGNATURES ARE READ FROM THE COMPILED ARTIFACT, NOT HAND-WRITTEN.
 * A hand-written list here previously contained
 * `DealRefunded(uint256,address,address)` while the contract emits
 * `DealRefunded(uint256,address)`. Circle accepts a monitor for a signature the
 * contract never emits — it just never fires, silently. Deriving from
 * `contracts/MarketEscrow.json` makes that class of mistake impossible.
 *
 * One monitor per event signature — Circle requires the signature WITHOUT
 * spaces, e.g. "OrderCreated(uint256,address,address,uint256,uint256)".
 *
 * The contract must already be imported into SCP first:
 *   npx tsx --env-file=.env.local scripts/import-contract-scp.ts
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/setup-event-monitors.ts
 *   npx tsx --env-file=.env.local scripts/setup-event-monitors.ts --list
 *   npx tsx --env-file=.env.local scripts/setup-event-monitors.ts --prune
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initiateSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";

const API_KEY = process.env.CIRCLE_API_KEY;
const ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
const ESCROW_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS;
const BLOCKCHAIN = "ARC-TESTNET";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The events we care about. Order/Deal lifecycle + fee collection.
 * Admin events (MiddlemanAdded, Paused, …) are deliberately excluded — they
 * don't move money and don't need a sub-minute sync.
 */
const TRACKED_EVENTS = new Set([
  "OrderCreated",
  "OrderReleased",
  "OrderRefunded",
  "DealCreated",
  "DealReleased",
  "DealRefunded",
  "FeesCollected",
]);

/** "OrderCreated(uint256,address,address,uint256,uint256)" — no spaces. */
function loadSignaturesFromArtifact(): string[] {
  const artifactPath = join(ROOT, "contracts", "MarketEscrow.json");
  const abi = JSON.parse(readFileSync(artifactPath, "utf8")).abi ?? [];
  const sigs = abi
    .filter((x: { type: string; name: string }) => x.type === "event" && TRACKED_EVENTS.has(x.name))
    .map(
      (e: { name: string; inputs: { type: string }[] }) =>
        `${e.name}(${e.inputs.map((i) => i.type).join(",")})`,
    );
  if (sigs.length !== TRACKED_EVENTS.size) {
    const found = new Set(sigs.map((s: string) => s.slice(0, s.indexOf("("))));
    const missing = [...TRACKED_EVENTS].filter((n) => !found.has(n));
    throw new Error(
      `artifact does not contain all tracked events; missing: ${missing.join(", ")}. ` +
        `Run scripts/compile-contract.mjs first.`,
    );
  }
  return sigs;
}

if (!API_KEY || !ENTITY_SECRET || !ESCROW_ADDRESS) {
  console.error("Missing env: CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / ESCROW_CONTRACT_ADDRESS");
  process.exit(1);
}

function client() {
  return initiateSmartContractPlatformClient({
    apiKey: API_KEY!,
    entitySecret: ENTITY_SECRET!,
  });
}

async function fetchMonitors() {
  const res = await client().listEventMonitors({
    blockchain: BLOCKCHAIN as never,
    contractAddress: ESCROW_ADDRESS,
  });
  return res.data?.eventMonitors ?? [];
}

async function listMonitors() {
  const monitors = await fetchMonitors();
  console.log(`Monitors for ${ESCROW_ADDRESS} on ${BLOCKCHAIN}: ${monitors.length}`);
  for (const m of monitors) {
    console.log(`  ${m.isEnabled ? "on " : "off"} ${m.eventSignature}  (id ${m.id})`);
  }
  const expected = new Set(loadSignaturesFromArtifact());
  const stale = monitors.filter((m) => !expected.has(m.eventSignature as string));
  if (stale.length) {
    console.log(`\n⚠️  ${stale.length} STALE monitor(s) (signature not present in the contract):`);
    for (const m of stale) console.log(`     ${m.eventSignature}  (id ${m.id})`);
    console.log("   Run with --prune to delete them.");
  }
}

async function pruneMonitors(expected: Set<string>) {
  const monitors = await fetchMonitors();
  let deleted = 0;
  for (const m of monitors) {
    if (expected.has(m.eventSignature as string)) continue;
    try {
      await client().deleteEventMonitor({ id: m.id as string });
      console.log(`  - ${m.eventSignature}  (deleted, id ${m.id})`);
      deleted++;
    } catch (e: unknown) {
      const err = e as { message?: string; response?: { data?: unknown } };
      console.error(`  ✗ failed to delete ${m.eventSignature} —`, err.message);
      if (err.response?.data) console.error("      ", JSON.stringify(err.response.data));
    }
  }
  return deleted;
}

async function main() {
  const scp = client();
  const signatures = loadSignaturesFromArtifact();

  console.log("=== Register SCP event monitors ===");
  console.log("  contract  :", ESCROW_ADDRESS);
  console.log("  blockchain:", BLOCKCHAIN);
  console.log("  signatures:", `${signatures.length} (from contracts/MarketEscrow.json)`);
  console.log("");

  // Existing monitors for THIS contract, so re-running this script is idempotent.
  const existing = new Set((await fetchMonitors()).map((m) => m.eventSignature as string));

  let created = 0;
  let skipped = 0;

  for (const eventSignature of signatures) {
    if (existing.has(eventSignature)) {
      console.log(`  = ${eventSignature}  (already registered)`);
      skipped++;
      continue;
    }
    try {
      const res = await scp.createEventMonitor({
        blockchain: BLOCKCHAIN as never,
        contractAddress: ESCROW_ADDRESS!,
        eventSignature,
      });
      const m = res.data?.eventMonitor;
      console.log(`  + ${eventSignature}  → id ${m?.id} (enabled: ${m?.isEnabled})`);
      created++;
    } catch (e: unknown) {
      const err = e as { message?: string; response?: { data?: unknown } };
      console.error(`  ✗ ${eventSignature} —`, err.message);
      if (err.response?.data) console.error("      ", JSON.stringify(err.response.data));
    }
  }

  let pruned = 0;
  if (process.argv.slice(2).includes("--prune")) {
    console.log("\n=== Prune stale monitors ===");
    pruned = await pruneMonitors(new Set(signatures));
    if (pruned === 0) console.log("  (nothing stale)");
  }

  console.log("");
  console.log(`Done. created=${created} skipped=${skipped} pruned=${pruned} total=${signatures.length}`);
  console.log("");
  console.log("NEXT (manual, in Circle Console):");
  console.log("  Create a webhook subscription limited to `contracts.EventLog`,");
  console.log("  pointing at https://<your-domain>/api/webhooks/escrow");
  console.log("  Without that subscription the monitors record history but push nothing.");
}

const args = process.argv.slice(2);
(args.includes("--list") ? listMonitors() : main()).catch((e) => {
  console.error("FAILED:", e?.response?.data ? JSON.stringify(e.response.data) : e.message || e);
  process.exit(1);
});
