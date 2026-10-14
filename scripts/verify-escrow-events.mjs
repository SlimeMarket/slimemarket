/**
 * Post-deploy check: do the deployed MarketEscrow's event signatures match our
 * compiled artifact?
 *
 * WHY THIS EXISTS
 * ---------------
 * This script is how we caught the 2026-09-26 drift bug. Three files hand-wrote
 * the escrow event ABI and all three disagreed with the contract on argument
 * count. Because `parseEventLogs` matches logs by topic0 = keccak256(signature),
 * a wrong arity makes viem skip the log SILENTLY — no error, no warning. The
 * escrow release path was unreachable and nothing complained.
 *
 * HOW IT PROVES IT
 * ----------------
 * solc inlines each event's topic hash as a PUSH32 constant in the runtime
 * bytecode, so the hash is literally present in the deployed code. We compute
 * keccak256(signature) from `contracts/MarketEscrow.json` and check it appears
 * on chain. That is direct evidence, not an assumption about which source was
 * compiled.
 *
 * Together with `__tests__/lib/escrow-events.test.ts` (generated TS ABI ==
 * artifact) this closes the chain: generated TS ABI == artifact == deployed code.
 *
 * Usage:
 *   node scripts/verify-escrow-events.mjs
 *   ESCROW_CONTRACT_ADDRESS=0x... node scripts/verify-escrow-events.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, http, keccak256, toBytes } from "viem";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const ESCROW = (process.env.ESCROW_CONTRACT_ADDRESS || "").toLowerCase();

if (!/^0x[0-9a-f]{40}$/.test(ESCROW)) {
  console.error("ESCROW_CONTRACT_ADDRESS not set (or invalid).");
  console.error("Run with: ESCROW_CONTRACT_ADDRESS=0x... node scripts/verify-escrow-events.mjs");
  process.exit(1);
}

const abi = JSON.parse(readFileSync(join(ROOT, "contracts", "MarketEscrow.json"), "utf8")).abi;
const events = abi.filter((x) => x.type === "event");
const signatureOf = (e) => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;

const client = createPublicClient({ transport: http(RPC) });

console.log(`RPC     : ${RPC}`);
console.log(`ESCROW  : ${ESCROW}`);

const code = await client.getBytecode({ address: ESCROW });
if (!code) {
  console.error("\n✗ No bytecode at that address — wrong network, or not deployed yet?");
  process.exit(1);
}
console.log(`bytecode: ${code.length} hex chars\n`);

const hexCode = code.toLowerCase();
let missing = 0;

console.log("=== Topic hashes from artifact vs runtime bytecode ===");
for (const e of events) {
  const sig = signatureOf(e);
  const topic = keccak256(toBytes(sig));
  const present = hexCode.includes(topic.slice(2));
  if (!present) missing++;
  console.log(`  ${present ? "✓" : "✗"} ${sig}`);
  if (!present) console.log(`      topic ${topic} NOT FOUND in bytecode`);
}

// Sanity check that this really is MarketEscrow and not some other contract.
console.log("\n=== Sanity check state ===");
const VIEW_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "platform", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "usdc", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "FEE_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "SELLER_FEE_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "orderCounter", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingFees", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
for (const f of VIEW_ABI) {
  try {
    const v = await client.readContract({ address: ESCROW, abi: VIEW_ABI, functionName: f.name });
    console.log(`  ${f.name.padEnd(15)} = ${v}`);
  } catch (err) {
    console.log(`  ${f.name.padEnd(15)} = ERROR ${err.shortMessage || err.message}`);
  }
}

console.log("");
if (missing > 0) {
  console.error(`✗ FAILED — ${missing} event(s) not found in bytecode.`);
  console.error("  Artifact and deployed contract are NOT in sync.");
  console.error("  Regenerate ABI: node scripts/gen-escrow-events.mjs");
  process.exit(1);
}
console.log(`✓ OK — all ${events.length} event signatures present in the deployed bytecode.`);
