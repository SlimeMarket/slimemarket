/**
 * .C — one-command, idempotent environment bootstrap & verification.
 *
 * Adopted from Circle's reference pattern (arc-ecommerce-payments
 * scripts/setup.ts): instead of creating wallets (ours already exist), this
 * VERIFIES the whole stack and reports PASS/FAIL per check, so a fresh clone
 * on a new server (VPS migration) can be proven healthy in one command.
 *
 * Checks:
 *   1. env      — every required var present (fails with the exact list)
 *   2. circle   — entity secret registered (DCW client round-trip)
 *   3. wallets  — platform DCW exists + address matches env (treasury sanity)
 *   4. escrow   — bytecode at ESCROW_CONTRACT_ADDRESS + owner == platform +
 *                 middlemen[platform] flag (the check that FOUND a real bug:
 *                 WL release/refund needs it; marketplace onlyOperator does not)
 *   5. rpc      — Arc testnet reachable, chainId 5042002
 *   6. faucet   — if treasury < 5 USDC: drip via Circle faucet API (non-fatal)
 *   7. upstash  — Redis REST ping (fail in prod, warn in dev)
 *
 * Usage:
 *   npm run setup:env
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, erc20Abi, type Hex } from "viem";

const BLOCKCHAIN = process.env.CIRCLE_BLOCKCHAIN || "ARC-TESTNET";
const ARC_RPC_URL = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = parseInt(process.env.ARC_CHAIN_ID || "5042002");
const USDC = "0x3600000000000000000000000000000000000000";
const TREASURY_FLOOR_USDC = 5n * 1000000n; // alert/drip when treasury USDC < 5
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";
const results: { name: string; status: CheckStatus; detail: string }[] = [];
function record(name: string, status: CheckStatus, detail: string) {
  results.push({ name, status, detail });
  const tag = { PASS: "✓", FAIL: "✗", WARN: "!", SKIP: "-" }[status];
  console.log(`  ${tag} ${name.padEnd(9)} ${detail}`);
}

function requiredEnv(): string[] {
  return [
    "CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "PLATFORM_CIRCLE_WALLET_ID",
    "NEXT_PUBLIC_AGENT_WALLET_ADDRESS", "TREASURY_WALLET_ID",
    "ESCROW_CONTRACT_ADDRESS", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY",
    "VALET_KEK_HEX", "CIRCLE_APP_ID", "INDEXER_CRON_SECRET",
  ];
}

function dcwClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function checkEnv(): Promise<boolean> {
  console.log("\n[1/7] Environment variables");
  const missing = requiredEnv().filter((k) => !process.env[k]);
  if (missing.length) {
    record("env", "FAIL", `missing: ${missing.join(", ")} — fill .env.local (see .env.example)`);
    return false;
  }
  if (process.env.NODE_ENV === "production" && process.env.CIRCLE_PAYMENTS_MOCK !== "0") {
    record("env", "WARN", `CIRCLE_PAYMENTS_MOCK=${process.env.CIRCLE_PAYMENTS_MOCK} in production — must be 0`);
  } else {
    record("env", "PASS", `${requiredEnv().length} required vars present`);
  }
  return true;
}

async function checkCircle(): Promise<boolean> {
  console.log("\n[2/7] Circle API + entity secret");
  try {
    // A bare listWallets() is the cheapest authenticated round-trip. SDK
    // error shape isn't in the success type; widen for the probe.
    const r = await dcwClient().listWallets();
    const resp = r as { errorCode?: number; errorMessage?: string };
    if (resp.errorCode && resp.errorCode !== 0) {
      record("circle", "FAIL", `errorCode ${resp.errorCode}: ${resp.errorMessage} (entity secret not registered? run scripts/register-entity.ts)`);
      return false;
    }
    record("circle", "PASS", "DCW API reachable, entity secret OK");
    return true;
  } catch (e) {
    record("circle", "FAIL", (e as Error).message.slice(0, 140));
    return false;
  }
}

async function checkPlatformWallet(): Promise<boolean> {
  console.log("\n[3/7] Platform / treasury wallet");
  try {
    const w = await dcwClient().getWallet({ id: process.env.PLATFORM_CIRCLE_WALLET_ID! });
    const addr = w.data?.wallet?.address;
    if (!addr) { record("wallets", "FAIL", "platform wallet not found in Circle"); return false; }
    const expected = (process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS || "").toLowerCase();
    if (expected && addr.toLowerCase() !== expected) {
      record("wallets", "FAIL", `${addr} != NEXT_PUBLIC_AGENT_WALLET_ADDRESS ${expected}`);
      return false;
    }
    const treasury = (process.env.TREASURY_WALLET_ID || "").toLowerCase();
    if (treasury && addr.toLowerCase() !== treasury) {
      record("wallets", "WARN", `TREASURY_WALLET_ID (${treasury}) differs from platform wallet (${addr}) — v4 expects treasury = platform`);
    } else {
      record("wallets", "PASS", addr);
    }
    return true;
  } catch (e) {
    record("wallets", "FAIL", (e as Error).message.slice(0, 140));
    return false;
  }
}

const VIEW_ABI = [
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "platform", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "middlemen", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;

async function checkEscrow(client: ReturnType<typeof publicArc> | null, rpcOk: boolean): Promise<boolean> {
  console.log("\n[4/7] MarketEscrow contract on Arc");
  if (!rpcOk || !client) { record("escrow", "SKIP", "Arc RPC unreachable"); return false; }
  const escrowAddr = process.env.ESCROW_CONTRACT_ADDRESS as Hex;
  try {
    const code = await client.getCode({ address: escrowAddr });
    if (!code || code === "0x") { record("escrow", "FAIL", `no bytecode at ${escrowAddr} — redeploy (contracts/deploy.ts)`); return false; }
    const owner = (await client.readContract({ address: escrowAddr, abi: VIEW_ABI, functionName: "owner" })) as string;
    const platformAddr = (await client.readContract({ address: escrowAddr, abi: VIEW_ABI, functionName: "platform" })) as string;
    const isMiddleman = (await client.readContract({ address: escrowAddr, abi: VIEW_ABI, functionName: "middlemen", args: [platformAddr as Hex] })) as boolean;
    const envPlatform = (process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS || "").toLowerCase();
    if (owner.toLowerCase() !== envPlatform) {
      record("escrow", "FAIL", `owner ${owner} != platform ${envPlatform} — deploy did not finish transferOwnership`);
      return false;
    }
    // Impact note: createOrderFor/releaseOrder/refundOrder are onlyOperator
    // (msg.sender == platform OR middlemen[]) → marketplace orders still work
    // WITHOUT the flag. ONLY releaseEscrow/refundEscrow (WL/rekber,
    // onlyMiddleman) revert → that flow is broken until repaired.
    if (!isMiddleman) {
      record("escrow", "FAIL", `middlemen[${platformAddr}] = false → WL (rekber) release/refund broken on-chain. Repair: owner is now the platform DCW, so submit addMiddleman(platform) via Circle (createContractExecutionTransaction with PLATFORM_CIRCLE_WALLET_ID)`);
      return false;
    }
    record("escrow", "PASS", `${code.length / 2 - 1} bytes · owner=platform ✓ · middleman ✓`);
    return true;
  } catch (e) {
    record("escrow", "FAIL", (e as Error).message.slice(0, 140));
    return false;
  }
}

function publicArc() {
  return createPublicClient({ transport: http(ARC_RPC_URL) });
}

async function checkRpc() {
  console.log("\n[5/7] Arc RPC");
  try {
    const client = publicArc();
    const [block, chainId] = await Promise.all([client.getBlockNumber(), client.getChainId()]);
    if (chainId !== ARC_CHAIN_ID) { record("rpc", "FAIL", `chainId ${chainId} != ${ARC_CHAIN_ID}`); return { ok: false, client: null as null | ReturnType<typeof publicArc> }; }
    record("rpc", "PASS", `block #${block} · chainId ${chainId}`);
    return { ok: true, client: client as null | ReturnType<typeof publicArc> };
  } catch (e) {
    record("rpc", "FAIL", (e as Error).message.slice(0, 120));
    return { ok: false, client: null as null | ReturnType<typeof publicArc> };
  }
}

/** USDC (6-decimals, native system asset on Arc) balance of treasury address. */
async function treasuryUsdc(client: ReturnType<typeof publicArc>): Promise<bigint> {
  const addr = (process.env.TREASURY_WALLET_ID || process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS) as Hex;
  return client.readContract({ address: USDC as Hex, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
}

async function checkFaucet(rpcOk: boolean, client: ReturnType<typeof publicArc> | null): Promise<void> {
  console.log("\n[6/7] Treasury funding (faucet)");
  if (!rpcOk || !client) { record("faucet", "SKIP", "rpc down"); return; }
  try {
    const bal = await treasuryUsdc(client);
    if (bal >= TREASURY_FLOOR_USDC) {
      record("faucet", "PASS", `treasury USDC = ${Number(bal) / 1e6}`);
      return;
    }
    console.log(`  treasury low (${Number(bal) / 1e6} USDC) — requesting faucet drip...`);
    const addr = process.env.TREASURY_WALLET_ID || process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS;
    const res = await fetch("https://api.circle.com/v1/faucet/drips", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ address: addr, blockchain: BLOCKCHAIN, native: true }),
    });
    if (!res.ok) {
      record("faucet", "WARN", `faucet API ${res.status} — fund manually at https://faucet.circle.com/testnet`);
      return;
    }
    for (let i = 0; i < 30; i++) {
      await sleep(4000);
      const after = await treasuryUsdc(client);
      if (after > bal) { record("faucet", "PASS", `funded: ${Number(after) / 1e6} USDC`); return; }
    }
    record("faucet", "WARN", "drip requested but balance unchanged after 2min — check faucet status");
  } catch (e) {
    record("faucet", "WARN", `non-fatal: ${(e as Error).message.slice(0, 100)}`);
  }
}

async function checkUpstash(): Promise<void> {
  console.log("\n[7/7] Upstash Redis (rate limiting)");
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const msg = "UPSTASH_* not set — production rate limiting fails closed (financial routes throw)";
    if (process.env.NODE_ENV === "production") record("upstash", "FAIL", msg);
    else record("upstash", "WARN", msg + " (dev in-memory fallback is fine here)");
    return;
  }
  try {
    const res = await fetch(`${url}/ping`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    if (res.ok && body.includes("PONG")) record("upstash", "PASS", "PONG");
    else record("upstash", "FAIL", `HTTP ${res.status} ${body.slice(0, 60)}`);
  } catch (e) {
    record("upstash", "FAIL", (e as Error).message.slice(0, 100));
  }
}

async function main() {
  console.log("=== SlimeMarket environment bootstrap (setup-env) ===");
  const envOk = await checkEnv();
  if (!envOk) { report(); return; }
  const circleOk = await checkCircle();
  if (circleOk) await checkPlatformWallet();
  else record("wallets", "SKIP", "circle down");
  const rpc = await checkRpc();
  const escrowOk = await checkEscrow(rpc.client, rpc.ok);
  await checkFaucet(rpc.ok, rpc.client);
  await checkUpstash();
  console.log(`\n  escrow contract fully healthy: ${escrowOk ? "yes" : "NO — fix before relying on WL escrow"}`);
  report();
}

function report() {
  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.name}: ${r.detail}`);
  const fails = results.filter(r => r.status === "FAIL").length;
  const warns = results.filter(r => r.status === "WARN").length;
  console.log(`\n  ${fails === 0 ? "✓ ENVIRONMENT HEALTHY" : "✗ " + fails + " failure(s)"} · ${warns} warning(s)`);
  if (fails > 0) process.exitCode = 1;
}

main().catch((e) => { console.error("setup-env crashed:", e); process.exit(1); });
