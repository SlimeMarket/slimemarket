/**
 * read-escrow-deal.mjs — dump the on-chain EscrowDeal tuple for one contract
 * deal id, straight from the Arc RPC. Read-only; used to confirm the contract's
 * own deadlines/flags when debugging the escape hatch.
 *
 * Usage: node scripts/tools/read-escrow-deal.mjs <onChainDealId> [<id> ...]
 */
import { createPublicClient, http } from "viem";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const env = {};
for (const line of readFileSync(path.join(REPO, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const RPC = env.ARC_RPC_URL;
const ADDR = env.ESCROW_CONTRACT_ADDRESS;
const client = createPublicClient({ transport: http(RPC) });

const ABI = [{
  type: "function", name: "deals", stateMutability: "view",
  inputs: [{ name: "", type: "uint256" }],
  outputs: [
    { name: "buyer", type: "address" }, { name: "seller", type: "address" },
    { name: "price", type: "uint256" }, { name: "fee", type: "uint256" },
    { name: "collateral", type: "uint256" }, { name: "collateralReturned", type: "uint256" },
    { name: "createdAt", type: "uint256" }, { name: "deliveryDeadline", type: "uint256" },
    { name: "confirmDeadline", type: "uint256" }, { name: "disputedAt", type: "uint256" },
    { name: "buyerDeposited", type: "bool" }, { name: "delivered", type: "bool" },
    { name: "buyerConfirmed", type: "bool" }, { name: "disputed", type: "bool" },
    { name: "released", type: "bool" }, { name: "refunded", type: "bool" },
    { name: "deliveryWindow", type: "uint256" },
  ],
}];

const ids = process.argv.slice(2);
if (!ids.length) { console.error("usage: node read-escrow-deal.mjs <id> [<id>...]"); process.exit(1); }

const now = Math.floor(Date.now() / 1000);
const fmt = (s) => (s > 0 ? `${new Date(s * 1000).toISOString()} (${s > now ? "+" : ""}${((s - now) / 3600).toFixed(1)}h)` : "0");

for (const id of ids) {
  const t = await client.readContract({ address: ADDR, abi: ABI, functionName: "deals", args: [BigInt(id)] });
  console.log(`\n=== deal ${id} ===`);
  console.log(`buyer=${t[0]} seller=${t[1]}`);
  console.log(`price=${t[2]} fee=${t[3]} collateral=${t[4]} collateralReturned=${t[5]}`);
  console.log(`createdAt        = ${fmt(Number(t[6]))}`);
  console.log(`deliveryDeadline = ${fmt(Number(t[7]))}   <-- refund clock`);
  console.log(`confirmDeadline  = ${fmt(Number(t[8]))}   <-- release clock`);
  console.log(`disputedAt       = ${fmt(Number(t[9]))}`);
  console.log(`buyerDeposited=${t[10]} delivered=${t[11]} buyerConfirmed=${t[12]} disputed=${t[13]} released=${t[14]} refunded=${t[15]}`);
  console.log(`deliveryWindow=${t[16]}s`);
}
