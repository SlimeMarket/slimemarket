#!/usr/bin/env node
/**
 * cuid-check — verifies users.circle_user_id is populated everywhere.
 *
 * BUG 14 context: /api/auth/unified read `users[0].userId` and `users[0].email`
 * off `GET /v1/w3s/users`. Neither field exists on Circle's EndUser object
 * (the identity field is `id`; there is no `email` at all), so
 * `circle_user_id` was written as null for 100% of accounts and the P0-1
 * email-mismatch guard silently never fired.
 *
 * Since `uid` IS the Circle userId (`createUser({ userId: uid })`), the row is
 * healthy when `circle_user_id === uid`.
 *
 * Usage:
 *   node scripts/tools/cuid-check.mjs            # report only
 *   node scripts/tools/cuid-check.mjs --fix      # backfill circle_user_id = uid
 */
import fs from "node:fs";
import path from "node:path";

const FIX = process.argv.includes("--fix");

const envPath = path.join(process.cwd(), ".env.local");
const env = fs.readFileSync(envPath, "utf8");
const get = (k) => {
  const m = env.match(new RegExp("^" + k + "=(.*)$", "m"));
  return m ? m[1].replace(/^["']|["']$/g, "").trim() : "";
};
const SUPA = get("NEXT_PUBLIC_SUPABASE_URL");
const KEY = get("SUPABASE_SERVICE_ROLE_KEY");
const h = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

const users = await (
  await fetch(`${SUPA}/rest/v1/users?select=id,uid,email,circle_user_id&limit=500`, { headers: h })
).json();

if (!Array.isArray(users)) {
  console.error("failed to read users:", JSON.stringify(users));
  process.exit(1);
}

const bad = users.filter((u) => !u.circle_user_id || u.circle_user_id !== u.uid);
console.log(`users: ${users.length}`);
console.log(`mismatched / missing circle_user_id: ${bad.length}`);
for (const u of bad) {
  console.log(`  ${u.uid.padEnd(6)} ${String(u.circle_user_id).padEnd(20)} ${u.email}`);
}

if (FIX && bad.length) {
  console.log("\nbackfilling circle_user_id = uid …");
  let ok = 0;
  for (const u of bad) {
    const r = await fetch(`${SUPA}/rest/v1/users?id=eq.${u.id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ circle_user_id: u.uid }),
    });
    if (r.status < 300) ok++;
    else console.log(`  FAILED ${u.uid}: ${r.status}`);
  }
  console.log(`patched ${ok}/${bad.length}`);
  const after = await (
    await fetch(`${SUPA}/rest/v1/users?select=circle_user_id&limit=500`, { headers: h })
  ).json();
  const left = after.filter((u) => !u.circle_user_id).length;
  console.log(`remaining null: ${left}/${after.length}`);
  process.exit(left === 0 ? 0 : 1);
}

process.exit(bad.length === 0 ? 0 : 1);
