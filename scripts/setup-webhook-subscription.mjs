/**
 * Register (or inspect) the Circle webhook subscription that delivers SCP
 * contract-event logs to `/api/webhooks/escrow`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The escrow event monitors registered by `scripts/setup-event-monitors.mjs`
 * only record history inside Circle. Nothing is PUSHED to the app until a
 * webhook SUBSCRIPTION exists for `contracts.eventLog`. The docs told you to
 * create it by hand in Circle Console — but the subscriptions API is reachable
 * with the same `CIRCLE_API_KEY` we already use everywhere else, so there is no
 * reason to click through a UI (and every reason not to: a hand-made
 * subscription is invisible to the repo).
 *
 * Verified against the SDK types:
 *   CreateSubscriptionRequest = { endpoint: string, notificationTypes?: string[] }
 *   NotificationType.ContractsEventLog = "contracts.eventLog"
 *
 * Circle requires the endpoint to be publicly reachable over HTTPS and to answer
 * a POST with 2XX.
 *
 * Usage:
 *   node scripts/setup-webhook-subscription.mjs --list
 *   node scripts/setup-webhook-subscription.mjs --create https://abc.trycloudflare.com
 *   node scripts/setup-webhook-subscription.mjs --delete <subscriptionId>
 *
 * `--create` accepts either the bare origin or the full endpoint; the
 * `/api/webhooks/escrow` path is appended when it is missing.
 */
import { readFileSync } from "node:fs";

// ---- env (minimal .env.local reader) --------------------------------------
const env = {};
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  console.error("Cannot read .env.local — run from the project root.");
  process.exit(1);
}

const API_KEY = env.CIRCLE_API_KEY;
const BASE = env.NEXT_PUBLIC_CIRCLE_BASE_URL || "https://api.circle.com";

// ---- CLI flags -------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

/**
 * Which receiver to register. The app has TWO:
 *   /api/webhooks/escrow → contracts.eventLog  (Smart Contract Platform)
 *   /api/webhooks/circle → transactions.inbound (Programmable Wallets)
 * Both are registered from this script so neither is a click-only secret.
 */
/**
 * Recover a real API path from an argument that Git Bash (MSYS) may have
 * rewritten. On Windows, MSYS converts a bare `/foo/bar` argument into a Windows
 * path, so `--path /api/webhooks/circle` arrives as
 * `C:/Program Files/Git/api/webhooks/circle` and the subscription is created for
 * a nonsense endpoint (Circle answers 400). Anchoring on the `/api/` segment
 * makes the flag safe to use from any shell.
 */
function normalisePath(raw) {
  if (!raw) return null;
  const m = raw.match(/(api\/[A-Za-z0-9/_-]*)$/);
  return m ? `/${m[1]}` : raw;
}

const WEBHOOK_PATH = normalisePath(flag("--path")) ?? "/api/webhooks/escrow";

/**
 * Comma-separated notification types. MUST be values from Circle's
 * `NotificationType` enum — a made-up string registers fine but never delivers.
 */
const NOTIFICATION_TYPES = (flag("--types") ?? "contracts.eventLog")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!API_KEY) {
  console.error("CIRCLE_API_KEY missing from .env.local");
  process.exit(1);
}

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

function normaliseEndpoint(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  if (!url.endsWith(WEBHOOK_PATH)) url += WEBHOOK_PATH;
  return url;
}

async function list() {
  const res = await api("GET", "/v2/notifications/subscriptions");
  if (res.status !== 200) {
    console.error(`Failed to read subscriptions: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    process.exit(1);
  }
  const subs = res.body?.data ?? [];
  console.log(`Active subscriptions: ${subs.length}\n`);
  for (const s of subs) {
    console.log(`  id       : ${s.id}`);
    console.log(`  endpoint : ${s.endpoint}`);
    console.log(`  types    : ${(s.notificationTypes ?? []).join(", ") || "(unrestricted)"}`);
    console.log(`  restricted: ${s.restricted ?? "?"}  status: ${s.status ?? "?"}`);
    console.log("");
  }
  return subs;
}

/** A quick-tunnel host. These rotate on every cloudflared restart. */
function isTunnelEndpoint(url) {
  try {
    return new URL(url).hostname.endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}

async function create(rawEndpoint) {
  const endpoint = normaliseEndpoint(rawEndpoint);
  console.log(`Endpoint : ${endpoint}`);
  console.log(`Types    : ${NOTIFICATION_TYPES.join(", ")}\n`);

  // Idempotency: never create a second subscription for the same endpoint.
  const existing = await list();
  const dup = existing.find((s) => (s.endpoint ?? "").replace(/\/+$/, "") === endpoint);
  if (dup) {
    console.log(`Subscription already exists for this endpoint (id ${dup.id}) — not recreating.`);
    return;
  }

  // A quick tunnel gets a NEW hostname on every restart, so the previous
  // subscription points at a dead URL and would just accumulate. Drop any other
  // trycloudflare subscription before adding this one — the app only ever wants
  // one live tunnel at a time.
  if (isTunnelEndpoint(endpoint)) {
    const stale = existing.filter((s) => isTunnelEndpoint(s.endpoint ?? ""));
    if (stale.length) {
      console.log(`${stale.length} stale tunnel subscription(s) will be replaced (their URL is dead):`);
      for (const s of stale) {
        await remove(s.id, { quiet: true });
        console.log(`  - removed: ${s.endpoint}`);
      }
      console.log("");
    }
  }

  const res = await api("POST", "/v2/notifications/subscriptions", {
    endpoint,
    notificationTypes: NOTIFICATION_TYPES,
  });

  if (res.status !== 200 && res.status !== 201) {
    console.error(`\nFAILED to create subscription: HTTP ${res.status}`);
    console.error(JSON.stringify(res.body, null, 2).slice(0, 900));
    console.error(
      "\nPossible causes:\n" +
        "  - endpoint not yet publicly reachable (tunnel not running?)\n" +
        "  - endpoint does not return 2XX for POST (check /api/webhooks/escrow)\n" +
        "  - endpoint is not HTTPS",
    );
    process.exit(1);
  }

  console.log("\nCREATED successfully:");
  console.log(JSON.stringify(res.body?.data ?? res.body, null, 2).slice(0, 700));
  console.log(
    `\n${NOTIFICATION_TYPES.join(", ")} events will now be PUSHED to that endpoint.\n` +
      "Check deliveries in the webhook_events table.",
  );
}

async function remove(id, opts = {}) {
  const res = await api("DELETE", `/v2/notifications/subscriptions/${id}`);
  if (res.status !== 200 && res.status !== 204) {
    console.error(`Failed to delete ${id}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    if (!opts.quiet) process.exit(1);
    return;
  }
  if (!opts.quiet) console.log(`Subscription ${id} deleted.`);
}

const endpoint = flag("--create");
const delId = flag("--delete");

if (delId) {
  await remove(delId);
} else if (endpoint) {
  await create(endpoint);
} else {
  await list();
  console.log("Usage:");
  console.log("  node scripts/setup-webhook-subscription.mjs --list");
  console.log("  node scripts/setup-webhook-subscription.mjs --create https://domain.com");
  console.log("  node scripts/setup-webhook-subscription.mjs --create https://domain.com \\");
  console.log("       --path /api/webhooks/circle --types transactions.inbound");
  console.log("  node scripts/setup-webhook-subscription.mjs --delete <subscriptionId>");
  console.log("");
  console.log("Valid --types values come from Circle's NotificationType enum:");
  console.log("  contracts.eventLog   → /api/webhooks/escrow   (Smart Contract Platform)");
  console.log("  transactions.inbound → /api/webhooks/circle   (Programmable Wallets)");
}
