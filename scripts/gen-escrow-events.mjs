/**
 * Generator: contracts/MarketEscrow.json  →  lib/contracts/escrow-events.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * There used to be THREE hand-written copies of the event ABI in the repo
 * (`lib/contracts/resolver.ts`, `lib/contracts/indexer.ts`,
 * `lib/contracts/event-monitor.ts`) and all three had DRIFTED from the contract:
 *
 *   event                 contract (correct)                    was written as
 *   OrderCreated          (uint256,address,address,uint256,uint256)  (uint256,address,address,uint256)
 *   OrderReleased         (uint256,address,address,uint256)          (uint256,address,address,uint256,uint256)
 *   DealRefunded          (uint256,address)                          (uint256,address,address)
 *
 * The effect was SILENT: `parseEventLogs` matches logs by topic0 (the keccak of
 * the signature). If the ABI is wrong, topic0 does not match, and viem simply
 * SKIPS that log without any error — so on_chain_order_id was never populated.
 *
 * The fix: one generated file that must not be edited by hand. Regenerate it
 * whenever the contract changes. Guarded by `__tests__/escrow-events.test.ts`.
 *
 * Usage: node scripts/gen-escrow-events.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(ROOT, "contracts", "MarketEscrow.json");
const OUT = join(ROOT, "lib", "contracts", "escrow-events.ts");

const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
const abi = artifact.abi ?? artifact;

const events = abi.filter((x) => x.type === "event");

/** "OrderCreated(uint256,address,address,uint256,uint256)" — no spaces. */
function signatureOf(e) {
  return `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;
}

function renderItem(e, indent) {
  const pad = " ".repeat(indent);
  const inputs = e.inputs
    .map(
      (i) =>
        `{ name: ${JSON.stringify(i.name ?? "")}, type: ${JSON.stringify(i.type)}, indexed: ${
          i.indexed ? "true" : "false"
        } }`,
    )
    .join(", ");
  return `${pad}{\n${pad}  name: ${JSON.stringify(e.name)},\n${pad}  type: "event",\n${pad}  anonymous: ${
    e.anonymous ? "true" : "false"
  },\n${pad}  inputs: [${inputs}],\n${pad}},`;
}

const all = events.map((e) => renderItem(e, 2)).join("\n");
const byName = (n) => events.find((e) => e.name === n);

const LIFECYCLE = [
  // marketplace orders
  "OrderReleased", "OrderRefunded", "OrderDelivered", "OrderConfirmed",
  // escrow / OTC deals
  "DealReleased", "DealRefunded", "DealRefundedWithSlash", "DealDisputed",
  "DealDelivered", "DealConfirmed", "CollateralAdded", "DealFunded",
  // platform fees
  "FeesCollected",
];
const CREATION = ["OrderCreated", "DealCreated"];

const lifecycle = LIFECYCLE.map((n) => {
  const e = byName(n);
  if (!e) throw new Error(`event ${n} is not present in the artifact`);
  return renderItem(e, 2);
}).join("\n");

const creation = CREATION.map((n) => {
  const e = byName(n);
  if (!e) throw new Error(`event ${n} is not present in the artifact`);
  return renderItem(e, 2);
}).join("\n");

const sigs = events
  .filter((e) => LIFECYCLE.includes(e.name) || CREATION.includes(e.name))
  .map((e) => `  ${JSON.stringify(signatureOf(e))},`)
  .join("\n");

const content = `/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 *
 * Source: \`contracts/MarketEscrow.json\` (compiled artifact).
 * Regenerate: \`node scripts/gen-escrow-events.mjs\`
 *
 * This is the single source of truth for the MarketEscrow event ABI on the
 * TypeScript side. The ABI used to be hand-written in 3 different files and all
 * three drifted from the contract — which made \`parseEventLogs\` skip logs
 * without raising an error. Do not repeat that.
 *
 * Guarded by \`__tests__/escrow-events.test.ts\`.
 */

/** Every MarketEscrow event (including admin events, for the audit log). */
export const ESCROW_EVENTS_ABI = [
${all}
] as const;

/**
 * Order/deal lifecycle events plus fee collection — the ones that change DB state.
 * Used by the polling indexer and the escrow webhook.
 */
export const ESCROW_LIFECYCLE_ABI = [
${lifecycle}
] as const;

/**
 * Order/deal creation events. Used to correlate a tx hash back to a contract id
 * (OrderCreated/DealCreated carry no DB id, so it has to be read from the
 * receipt of the tx WE sent).
 */
export const ESCROW_CREATION_ABI = [
${creation}
] as const;

/** Signatures without spaces, for registering as SCP event monitors. */
export const ESCROW_EVENT_SIGNATURES = [
${sigs}
] as const;
`;

writeFileSync(OUT, content, "utf8");
console.log(`✓ wrote ${OUT}`);
console.log(`  ${events.length} events total`);
console.log(`  ${LIFECYCLE.length} lifecycle + ${CREATION.length} creation = ${LIFECYCLE.length + CREATION.length} tracked`);
for (const e of events.filter((x) => LIFECYCLE.includes(x.name) || CREATION.includes(x.name))) {
  console.log(`    ${signatureOf(e)}`);
}
