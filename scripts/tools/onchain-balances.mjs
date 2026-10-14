#!/usr/bin/env node
/**
 * Read-only on-chain balance probe for the Arc testnet marketplace:
 *   - treasury (platform DCW / deployer address)
 *   - MarketEscrow contract (holds escrowed USDC + pending fees)
 *   - a list of extra addresses (user wallets) from the CLI
 *
 * Usage: node scripts/tools/onchain-balances.mjs [addr1 addr2 ...]
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, formatUnits, getAddress, parseAbi } from "viem";

const ROOT = process.cwd();
function loadEnv(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[s.slice(0, i).trim()] = v;
  }
  return out;
}
const env = { ...loadEnv(".env.local"), ...process.env };
const RPC = env.ARC_RPC_URL;
const TREASURY = env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS;
const ESCROW = env.ESCROW_CONTRACT_ADDRESS;
const USDC = env.USDC_CONTRACT_ADDRESS || env.NEXT_PUBLIC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000";

if (!RPC) { console.error("ARC_RPC_URL missing"); process.exit(1); }

const client = createPublicClient({ transport: http(RPC) });
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

let decimals = 6;
try { decimals = await client.readContract({ address: getAddress(USDC), abi: erc20, functionName: "decimals" }); } catch {}
let symbol = "USDC";
try { symbol = await client.readContract({ address: getAddress(USDC), abi: erc20, functionName: "symbol" }); } catch {}

async function usdcBalance(addr) {
  try {
    const raw = await client.readContract({ address: getAddress(USDC), abi: erc20, functionName: "balanceOf", args: [getAddress(addr)] });
    return { raw, human: formatUnits(raw, decimals) };
  } catch (e) {
    return { error: e.shortMessage || e.message };
  }
}

async function nativeBalance(addr) {
  try {
    const raw = await client.getBalance({ address: getAddress(addr) });
    return { raw, human: formatUnits(raw, 18) };
  } catch (e) {
    return { error: e.shortMessage || e.message };
  }
}

const block = await client.getBlockNumber();
console.log(`chain=RPC ok  block=${block}  USDC=${USDC} (${symbol}, ${decimals}dp)\n`);

const targets = [
  ["TREASURY (DCW)", TREASURY],
  ["ESCROW contract", ESCROW],
  ...process.argv.slice(2).map((a) => ["arg", a]),
].filter(([, a]) => a);

for (const [label, addr] of targets) {
  const [u, n] = await Promise.all([usdcBalance(addr), nativeBalance(addr)]);
  console.log(`${label.padEnd(18)} ${addr}`);
  console.log(`   ${symbol.padEnd(6)} = ${u.human ?? "ERR " + u.error}`);
  console.log(`   native = ${n.human ?? "ERR " + n.error}`);
}
