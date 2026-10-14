/**
 * probe-anon-audit-insert.mjs — PROOF that an unauthenticated caller can write
 * to mm_audit_log. Inserts one clearly-marked row with the ANON key (no login),
 * reports the HTTP status, then deletes it again with the service-role key.
 *
 * Read-only w.r.t. everything else: touches exactly one row, added and removed.
 *
 * Usage: node --env-file=.env.local scripts/tools/probe-anon-audit-insert.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const env = {};
for (const line of readFileSync(path.join(REPO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;

if (!URL_BASE || !ANON) {
  console.error("need NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
  process.exit(2);
}

const MARKER = `__anon-probe-${Date.now()}`;
// Every NOT NULL column must be present or the insert fails on the constraint
// BEFORE RLS is even reached. `action` must be in the migration-0068 allowlist.
const body = {
  mm_wallet_id: "anon-probe",
  action: "CANCEL_WL_DEAL",
  ref_id: MARKER,
  actor_type: "user",
  detail: { probe: MARKER },
};

console.log(`POST /rest/v1/mm_audit_log as ANON (no auth token)\n`);

const res = await fetch(`${URL_BASE}/rest/v1/mm_audit_log`, {
  method: "POST",
  headers: {
    apikey: ANON,
    Authorization: `Bearer ${ANON}`,
    "Content-Type": "application/json",
    // NOTE: deliberately NOT `return=representation`. That makes PostgREST add a
    // RETURNING clause, which needs SELECT — and the read policy is
    // `USING (false)` — so the request fails on the READ policy and masks the
    // fact that the INSERT itself was permitted.
    Prefer: "return=minimal",
  },
  body: JSON.stringify(body),
});

const text = await res.text();
console.log(`status: ${res.status}`);
console.log(`body  : ${text.slice(0, 200)}`);

const wrote = res.status === 201 || res.status === 200;
console.log(
  wrote
    ? "\n🔴 VULNERABLE — anon INSERTED a row into the audit log."
    : "\n✅ blocked — anon could not write.",
);

// Clean up with the service role so the probe leaves no trace.
if (wrote && SERVICE) {
  const del = await fetch(`${URL_BASE}/rest/v1/mm_audit_log?ref_id=eq.${MARKER}`, {
    method: "DELETE",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  console.log(`cleanup: DELETE → ${del.status}`);
}

process.exit(wrote ? 1 : 0);
