/**
 * check-contract-addresses.mjs — compare the escrow contract address referenced
 * by each env file against what is actually deployed on Arc, so a stale pointer
 * (e.g. .env.production still aiming at an old deploy) is caught before ship.
 *
 * Usage: node scripts/tools/check-contract-addresses.mjs
 */
import { createPublicClient, http } from "viem";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");

function loadEnv(file) {
  const p = path.join(REPO, file);
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const local = loadEnv(".env.local");
const prod = loadEnv(".env.production");
const rpc = local.ARC_RPC_URL || prod.ARC_RPC_URL;
const client = createPublicClient({ transport: http(rpc) });

const ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "MIN_DELIVERY_WINDOW", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "CONFIRM_WINDOW", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

const wanted = new Map();
for (const [file, env] of [[".env.local", local], [".env.production", prod]]) {
  const a = env.ESCROW_CONTRACT_ADDRESS;
  if (a) {
    if (!wanted.has(a)) wanted.set(a, []);
    wanted.get(a).push(file);
  }
}

console.log(`RPC: ${rpc}\n`);
let stale = 0;
for (const [addr, files] of wanted) {
  console.log(`${addr}   <- ${files.join(", ")}`);
  const code = await client.getBytecode({ address: addr });
  const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  console.log(`  code: ${size} bytes ${size === 0 ? "  ❌ NO CONTRACT DEPLOYED HERE" : ""}`);
  if (size === 0) stale++;
  for (const fn of ["owner", "MIN_DELIVERY_WINDOW", "CONFIRM_WINDOW"]) {
    try {
      const v = await client.readContract({ address: addr, abi: ABI, functionName: fn });
      console.log(`  ${fn} = ${v}`);
    } catch (e) {
      console.log(`  ${fn} = ERR ${String(e.message).split("\n")[0].slice(0, 70)}`);
    }
  }
  console.log();
}

if (wanted.size > 1) {
  console.log("⚠️  The env files DISAGREE on ESCROW_CONTRACT_ADDRESS:");
  for (const [addr, files] of wanted) console.log(`   ${addr}  (${files.join(", ")})`);
}
console.log(stale ? `\n${stale} address(es) have no code — stale pointer.` : "\nAll referenced addresses have code.");
