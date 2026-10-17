import { jsonOk, jsonError } from "@/lib/utils";
import { isContractReady } from "@/lib/contracts/escrow-client";
import {
  ARC_CHAIN_ID,
  ARC_EXPLORER_URL,
  ARC_RPC_URL,
  ARC_USDC_CONTRACT,
  IS_ARC_MAINNET,
  arcPublicClient,
} from "@/lib/arc";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export const dynamic = "force-dynamic";

// RPC/chain come from lib/arc (env-driven). The old fallback here was the
// retired rpc.testnet.arc.network host, so an env-less deploy reported the
// wrong network — and the frontend trusts this endpoint for chain metadata.
const RPC_URL = ARC_RPC_URL;
const ESCROW_ADDR = process.env.ESCROW_CONTRACT_ADDRESS ?? "";

async function checkDb() {
  try {
    const { supabaseAdminClient } = await import("@/lib/supabase/admin-client");
    const sb = supabaseAdminClient();
    const { error } = await sb.from("users").select("id").limit(1);
    return { ok: !error, detail: error ? error.message : "supabase-ok" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "db-error" };
  }
}

async function checkRpc() {
  try {
    const { createPublicClient, http } = await import("viem");
    const client = createPublicClient({ transport: http(RPC_URL) });
    const block = await client.getBlockNumber();
    return { ok: true, detail: `block #${block}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "rpc-error" };
  }
}

async function checkCircle() {
  try {
    const key = process.env.CIRCLE_API_KEY;
    if (!key) return { ok: false, detail: "CIRCLE_API_KEY not set" };
    const r = await fetch("https://api.circle.com/v1/w3s/ping", {
      headers: { Authorization: `Bearer ${key}` },
      // 10s, not 5s. A 5s budget produced false "degraded" reports whenever the
      // operator's own uplink was slow (e.g. VPN/Cloudflare WARP turned off,
      // routing over a consumer ISP in a region with poor latency to Circle).
      // That is a local-network condition, not a Circle outage — and a health
      // check that cries wolf is worse than a slightly slower one.
      signal: AbortSignal.timeout(10_000),
    });
    // Any HTTP response (even 404 on the ping path) proves api.circle.com is
    // reachable and auth headers are being sent — only network-level failures
    // (throw) or auth rejections (401/403) should mark Circle unhealthy.
    // The ping path itself has been unstable across Circle API versions, so
    // treating 404 as down caused a permanent false "degraded" status.
    const authProblem = r.status === 401 || r.status === 403;
    return { ok: !authProblem, detail: `circle-api ${r.status}${r.ok ? "" : " (reachable)"}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "circle-error";
    // Distinguish "network cannot reach Circle" from "Circle is broken" so the
    // operator knows to check their own connection (VPN / proxy / ISP) first.
    const networkish = /timeout|abort|fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(msg);
    return {
      ok: false,
      detail: networkish ? `unreachable from this host (check VPN/proxy/ISP): ${msg}` : msg,
    };
  }
}

async function checkEscrow() {
  try {
    const isReady = isContractReady();
    if (!isReady) return { ok: false, detail: "escrow-client not initialized" };
    // Quick eth_call to check contract bytecode exists
    const { createPublicClient, http } = await import("viem");
    const client = createPublicClient({ transport: http(RPC_URL) });
    const code = await client.getCode({ address: ESCROW_ADDR as `0x${string}` });
    return { ok: !!code && code !== "0x", detail: `contract@${ESCROW_ADDR} (${code?.length ?? 0} bytes)` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "escrow-error" };
  }
}

/**
 * the indexer cursor must not fall behind the chain. If it does, escrow
 * events stop being mirrored: orders keep their stale on_chain_status and the
 * reconciler cannot see settled releases. We report lag in blocks and fail the
 * check past a generous threshold (the indexer advances up to 2000 blocks/run).
 */
const INDEXER_MAX_LAG_BLOCKS = 5000;
async function checkIndexer(): Promise<{ ok: boolean; detail: string }> {
  try {
    const admin = supabaseAdminClient();
    const { data, error } = await admin
      .from("indexer_state")
      .select("last_processed_block, updated_at")
      .eq("id", "market_escrow")
      .maybeSingle();
    if (error) return { ok: false, detail: `indexer_state read failed: ${error.message}` };
    if (!data) return { ok: false, detail: "indexer_state row missing — indexer never ran" };

    const last = Number(data.last_processed_block ?? 0);
    const head = Number(await arcPublicClient().getBlockNumber());
    const lag = head - last;
    if (lag > INDEXER_MAX_LAG_BLOCKS) {
      return { ok: false, detail: `indexer lag ${lag} blocks (head ${head}, cursor ${last})` };
    }
    return { ok: true, detail: `lag ${lag} blocks (cursor ${last})` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "indexer-error" };
  }
}

/**
 * Upstash backs the per-user financial rate limits, which THROW in
 * production when unconfigured (money endpoints 500). Surface it here so a
 * misconfigured deploy is visible instead of mysterious.
 */
async function checkRedis(): Promise<{ ok: boolean; detail: string }> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false, detail: "UPSTASH_REDIS_REST_URL/TOKEN not set" };
  try {
    const res = await fetch(`${url}/ping`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, detail: res.ok ? "reachable" : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "redis-error" };
  }
}

/**
 * Turnstile used to be MANDATORY in production, and a missing site key
 * made the platform dead on arrival:
 *   no site key → the browser never renders the widget (public/auth.jsx gates it
 *   on the key) → no `turnstileToken` is ever sent → `requireTurnstile` in
 *   /api/auth/email-otp rejects EVERY request with 403 → nobody can sign up or
 *   log in. It was invisible locally because that check is skipped outside
 *   production, which is why it lives in /api/health.
 *
 * 2026-09-27 — Turnstile is now DISABLED by default (opt-in via
 * TURNSTILE_ENABLED=true), so an unconfigured Turnstile is no longer a blocker.
 * The check below only turns red when Turnstile is explicitly ENABLED but the
 * keys are missing/incomplete.
 *
 * Accepts either spelling of the site key — see app/config.js/route.ts.
 */
async function checkTurnstile(): Promise<{ ok: boolean; detail: string }> {
  const site =
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || process.env.TURNSTILE_SITE_KEY || "";
  const secret = process.env.TURNSTILE_SECRET_KEY || "";

  if (process.env.TURNSTILE_ENABLED !== "true") {
    return { ok: true, detail: "disabled (set TURNSTILE_ENABLED=true to enforce)" };
  }
  if (process.env.NODE_ENV !== "production") {
    return { ok: true, detail: "skipped (non-production — OTP check is bypassed)" };
  }
  if (!site && !secret) {
    return {
      ok: false,
      detail: "TURNSTILE_ENABLED=true but TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY unset — every OTP request will 403",
    };
  }
  if (!site) {
    return {
      ok: false,
      detail: "TURNSTILE_ENABLED=true but TURNSTILE_SITE_KEY unset — the widget never renders, so every OTP request will 403",
    };
  }
  if (!secret) {
    return { ok: false, detail: "TURNSTILE_ENABLED=true but TURNSTILE_SECRET_KEY unset — every OTP request will fail verification" };
  }
  return { ok: true, detail: `enabled (site key …${site.slice(-6)})` };
}

export async function GET() {
  const [db, rpc, circle, escrow, indexer, redis, turnstile] = await Promise.allSettled([
    checkDb(), checkRpc(), checkCircle(), checkEscrow(), checkIndexer(), checkRedis(), checkTurnstile(),
  ]);

  const get = (r: PromiseSettledResult<{ ok: boolean; detail: string }>) =>
    r.status === "fulfilled" ? r.value : { ok: false, detail: "promise rejected" };

  const checks = {
    db: get(db),
    rpc: get(rpc),
    circle: get(circle),
    escrow: get(escrow),
    indexer: get(indexer),
    redis: get(redis),
    turnstile: get(turnstile),
  };

  const allOk = Object.values(checks).every(c => c.ok);

  // report the real status code. Previously this always returned 200
  // even when every dependency was down, so no uptime monitor could ever fire.
  return jsonOk({
    name: "SlimeMarket API",
    status: allOk ? "ok" : "degraded",
    version: "0.1.0",
    chain: IS_ARC_MAINNET ? "arc-mainnet" : "arc-testnet",
    chainId: ARC_CHAIN_ID,
    onChainFunds: process.env.ONCHAIN_WALLET_FUNDS === "1",
    // .D3 — FE needs these to build EOA WalletBridge calldata
    // (approve + depositEscrowCollateral) without a second round-trip.
    escrowAddress: process.env.ESCROW_CONTRACT_ADDRESS || null,
    usdcAddress: process.env.CIRCLE_USDC_CONTRACT || ARC_USDC_CONTRACT,
    // Block explorer BASE for the active network. The FE builds tx links as
    // `${explorerUrl}/tx/<hash>` — never hardcode a host in a component, or
    // mainnet users end up on the testnet explorer.
    explorerUrl: ARC_EXPLORER_URL,
    uptime: process.uptime(),
    checks,
    time: new Date().toISOString(),
  }, allOk ? 200 : 503);
}
