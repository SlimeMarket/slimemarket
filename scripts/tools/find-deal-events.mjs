/**
 * find-deal-events.mjs — locate the on-chain lifecycle events for one contract
 * deal id and print their block numbers. Used to rewind the indexer cursor so a
 * missed event can be re-processed, and to verify what the chain actually did.
 *
 * Usage: node scripts/tools/find-deal-events.mjs <onChainDealId> [lookbackBlocks]
 */
import { createPublicClient, http, parseAbiItem } from "viem";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const env = {};
for (const line of readFileSync(path.join(REPO, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const client = createPublicClient({ transport: http(env.ARC_RPC_URL) });
const ADDR = env.ESCROW_CONTRACT_ADDRESS;
const id = process.argv[2];
const lookback = BigInt(process.argv[3] ?? "300000");
if (!id) { console.error("usage: find-deal-events.mjs <onChainDealId> [lookbackBlocks]"); process.exit(1); }

const EVENTS = [
  "event DealCreated(uint256 indexed id, address buyer, address seller, uint256 price, uint256 fee, uint256 collateral)",
  "event DealFunded(uint256 indexed id, address buyer, uint256 price, uint256 fee)",
  "event DealDelivered(uint256 indexed id, address seller, uint256 confirmDeadline)",
  "event DealDisputed(uint256 indexed id, address by)",
  "event DealConfirmed(uint256 indexed id, address buyer)",
  "event DealReleased(uint256 indexed id, address mm, address seller, uint256 payout, uint256 collateralReturned)",
  "event DealRefunded(uint256 indexed id, address mm, address buyer, uint256 amount, uint256 collateralReturned)",
  "event DealRefundedWithSlash(uint256 indexed id, address mm, address buyer, uint256 price, uint256 collateral)",
  "event CollateralAdded(uint256 indexed id, address seller, uint256 extra, uint256 total)",
];

const head = await client.getBlockNumber();
const from = head > lookback ? head - lookback : 0n;
console.log(`deal ${id} — scanning blocks ${from}..${head}\n`);

for (const sig of EVENTS) {
  const item = parseAbiItem(sig);
  const logs = await client.getLogs({
    address: ADDR, event: item, args: { id: BigInt(id) }, fromBlock: from, toBlock: head,
  }).catch(() => []);
  for (const l of logs) {
    console.log(`${l.eventName.padEnd(22)} block ${l.blockNumber}  tx ${l.transactionHash}`);
    console.log(`   args: ${JSON.stringify(l.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
}
