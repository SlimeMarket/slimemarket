#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
const H = { apikey: key, Authorization: `Bearer ${key}` };

const r = await fetch(`${url}/rest/v1/users?select=id,name,handle,role,email&order=joined_at.desc`, { headers: H });
const u = await r.json();
const by = {};
for (const x of u) by[x.role] = (by[x.role] || 0) + 1;
console.log("role distribution:", JSON.stringify(by));
console.log("");
for (const x of u) console.log(" ", String(x.role).padEnd(8), String(x.handle || x.name).padEnd(20), x.email, x.id.slice(0, 8));

console.log("\n=== chat_threads ===");
const t = await fetch(`${url}/rest/v1/chat_threads?select=*&order=created_at.desc&limit=5`, { headers: H });
console.log(JSON.stringify(await t.json(), null, 2).slice(0, 900));

console.log("\n=== chat_messages columns (constraint target) ===");
const c = await fetch(`${url}/rest/v1/chat_messages?select=*&limit=1`, { headers: H });
const rows = await c.json();
if (rows[0]) console.log(Object.keys(rows[0]).join(", "));
