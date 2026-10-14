/**
 * In-process cron scheduler — self-hosted (VPS) replacement for Vercel crons.
 * Run it alongside `next start`, or as a standalone process under a supervisor
 * (PM2 / systemd). It is NOT started by `npm start`.
 *
 * Usage: node scripts/scheduler.js   (or: npm run cron)
 *
 * rewritten as ESM. package.json declares "type": "module", so the
 * previous `require("node-cron")` threw "require is not defined in ES module
 * scope" and the scheduler could never start: the self-hosted cron path was
 * dead on arrival. Also added the two jobs it was missing:
 *   - /api/admin/auto-release        (42h seller auto-settlement)
 *   - /api/admin/reconcile/onchain-ids (resolve missing on-chain ids)
 */
import cron from "node-cron";

const PORT = process.env.PORT ?? 3000;
const BASE_URL = process.env.INTERNAL_API_URL ?? `http://localhost:${PORT}`;
// Accept either name, matching lib/utils/cron-auth.ts on the server side.
const SECRET = process.env.INDEXER_CRON_SECRET ?? process.env.CRON_SECRET ?? "";

if (!SECRET) {
  console.warn("[cron] WARNING: INDEXER_CRON_SECRET not set — jobs will get 401");
}

const HEADERS = { "Content-Type": "application/json" };
if (SECRET) HEADERS["Authorization"] = `Bearer ${SECRET}`;

async function fire(path, desc) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: HEADERS });
    const text = await res.text();
    const sha = text.slice(0, 100).replace(/\n/g, " ");
    const tag = res.ok ? "OK" : `FAIL(${res.status})`;
    console.log(`[cron] ${desc.padEnd(35)} ${tag.padEnd(10)} ${sha}`);
  } catch (e) {
    console.error(`[cron] ${desc}: ERROR — ${e.message}`);
  }
}

/**
 * NOTE on the escrow event indexer (first job):
 * `/api/webhooks/escrow` now receives SCP `contracts.eventLog` pushes and
 * applies the same DB writes, so this poller is a SAFETY NET, not the primary
 * path. Do NOT lower its frequency until the webhook subscription exists in
 * Circle Console (limited to `contracts.EventLog` → /api/webhooks/escrow) and
 * you have seen a real delivery land. Once verified, `0 * * * *` is plenty.
 * `/api/admin/reconcile/onchain-ids` must stay regardless: the webhook cannot
 * always correlate creation events back to a DB row.
 */
const jobs = [
  ["* * * * *",         "/api/admin/indexer/run",                "escrow event indexer"],
  ["*/5 * * * *",      "/api/admin/reconcile/failed-withdrawals","wallet_txs reconciler"],
  ["*/5 * * * *",      "/api/admin/sweep/allowance",             "dangling USDC allowance sweep"],
  ["*/10 * * * *",     "/api/admin/sweep/drafts",               "expired checkout draft cleanup"],
  ["*/5 * * * *",      "/api/admin/reconcile/onchain-releases",  "on-chain release/refund reconciler"],
  ["*/5 * * * *",      "/api/admin/reconcile/onchain-ids",       "missing on-chain id resolver"],
  ["*/5 * * * *",      "/api/admin/cross-chain/relay",           "CCTP bridge mint relay"],
  ["*/5 * * * *",      "/api/admin/auto-release",                "42h seller auto-release"],
  ["0 * * * *",        "/api/admin/reconcile/balance",           "hourly ledger balance reconciliation"],
];

console.log(`[cron] ${jobs.length} jobs → ${BASE_URL}`);
for (const [schedule, path, desc] of jobs) {
  cron.schedule(schedule, () => fire(path, desc), { timezone: "UTC" });
  console.log(`  ✓ ${schedule.padEnd(14)} → ${path}`);
}
