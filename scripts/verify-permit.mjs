// F0 verification: does Arc native USDC support EIP-2612 permit?
// Also reads deployed MarketEscrow state. Run:
//   npx tsx --env-file=.env.local scripts/verify-permit.mjs
import { createPublicClient, http, getContract } from "viem";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
const USDC = (process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS ??
  "0x3600000000000000000000000000000000000000");
const ESCROW = process.env.ESCROW_CONTRACT_ADDRESS ?? "";
const PROBE = process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS ??
  "0x0000000000000000000000000000000000000001";

const chain = {
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [RPC] } },
};

const client = createPublicClient({ chain, transport: http(RPC) });

const usdcAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

const escrowAbi = [
  { type: "function", name: "usdc", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "platform", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "orderCounter", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingFees", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { ok, value, reverted } — distinguishes contract revert (function
// absent / reverts) from transient transport errors (retried up to 5x).
async function tryRead(label, fn, attempts = 5) {
  let lastMsg = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const v = await fn();
      console.log(`  ✅ ${label}: ${v}`);
      return { ok: true, value: v, reverted: false };
    } catch (e) {
      const msg = (e?.shortMessage || e?.message || String(e)).split("\n")[0];
      lastMsg = msg;
      const reverted = /revert|execution reverted|returned no data|0x$/i.test(msg);
      if (reverted) {
        console.log(`  ❌ ${label}: REVERTED (${msg})`);
        return { ok: false, value: undefined, reverted: true };
      }
      await sleep(400 * (i + 1)); // backoff for transient RPC errors
    }
  }
  console.log(`  ⚠️  ${label}: transport-fail after ${attempts} tries (${lastMsg})`);
  return { ok: false, value: undefined, reverted: false };
}

async function main() {
  console.log(`\n=== F0 Verify · Arc chainId=${CHAIN_ID} · RPC=${RPC} ===`);

  const block = await tryRead("blockNumber", () => client.getBlockNumber());
  if (block === undefined) {
    console.log("\n⛔ RPC unreachable — cannot verify. Check network/proxy.\n");
    process.exit(2);
  }

  console.log(`\n[USDC ${USDC}]`);
  const code = await client.getBytecode({ address: USDC }).catch(() => undefined);
  console.log(`  bytecode: ${code ? `${(code.length - 2) / 2} bytes` : "NONE (precompile/native?)"}`);
  const usdc = getContract({ address: USDC, abi: usdcAbi, client });
  await tryRead("name()", () => usdc.read.name());
  const ver = await tryRead("version()", () => usdc.read.version());
  if (!ver.ok) await tryRead("VERSION()", () => usdc.read.VERSION());
  await tryRead("decimals()", () => usdc.read.decimals());
  const dom = await tryRead("DOMAIN_SEPARATOR()", () => usdc.read.DOMAIN_SEPARATOR());
  const nonce = await tryRead(`nonces(${PROBE})`, () => usdc.read.nonces([PROBE]));

  let permitVerdict;
  if (dom.ok && nonce.ok) permitVerdict = "YES ✅ (F2 primary path: permit)";
  else if (dom.reverted || nonce.reverted) permitVerdict = "NO ❌ (revert → Fallback A: approve via challenge)";
  else permitVerdict = "UNKNOWN ⚠️ (transport error — retry once RPC is stable)";
  console.log(`\n  >>> EIP-2612 permit supported: ${permitVerdict}`);

  if (ESCROW) {
    console.log(`\n[MarketEscrow ${ESCROW}]`);
    const ecode = await client.getBytecode({ address: ESCROW }).catch(() => undefined);
    console.log(`  bytecode: ${ecode ? `${(ecode.length - 2) / 2} bytes (deployed)` : "NONE (NOT deployed!)"}`);
    if (ecode) {
      const es = getContract({ address: ESCROW, abi: escrowAbi, client });
      await tryRead("usdc()", () => es.read.usdc());
      await tryRead("treasury()", () => es.read.treasury());
      await tryRead("platform()", () => es.read.platform());
      await tryRead("owner()", () => es.read.owner());
      await tryRead("paused()", () => es.read.paused());
      await tryRead("orderCounter()", () => es.read.orderCounter());
      await tryRead("pendingFees()", () => es.read.pendingFees());
    }
  } else {
    console.log("\n[MarketEscrow] ESCROW_CONTRACT_ADDRESS empty — skip");
  }

  console.log(`\n=== DECISION ===`);
  console.log(`Permit verdict: ${permitVerdict}`);
  console.log(`Write this into DEVLOG.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
