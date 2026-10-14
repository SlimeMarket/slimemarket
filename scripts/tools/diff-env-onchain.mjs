/**
 * diff-env-onchain.mjs — compare the on-chain-relevant keys between env files
 * (addresses, chain, flags) WITHOUT printing any secret. Catches a stale
 * contract / wallet / chain pointer in .env.production.
 *
 * Usage: node scripts/tools/diff-env-onchain.mjs [.env.local .env.production ...]
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const files = process.argv.slice(2);
if (!files.length) files.push(".env.local", ".env.production");

const WANT = /(ADDRESS|CONTRACT|WALLET_ID|RPC_URL|CHAIN_ID|ONCHAIN|FUNDS|USDC|ARC_|ESCROW)/i;
const SECRET = /(SECRET|KEY|TOKEN|PASSWORD|PASS|SALT|MNEMONIC|PRIVATE)/i;

function load(file) {
  const p = path.join(REPO, file);
  if (!existsSync(p)) return null;
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

const envs = files.map((f) => [f, load(f)]);
const keys = new Set();
for (const [, e] of envs) if (e) for (const k of Object.keys(e)) if (WANT.test(k) && !SECRET.test(k)) keys.add(k);

const w = Math.max(...[...keys].map((k) => k.length), 10);
console.log("KEY".padEnd(w) + " | " + envs.map(([f]) => f.padEnd(28)).join(" | "));
console.log("-".repeat(w) + "-+-" + envs.map(() => "-".repeat(28)).join("-+-"));
let diffs = 0;
for (const k of [...keys].sort()) {
  const vals = envs.map(([, e]) => (e && k in e ? e[k] : "(absent)"));
  const uniq = new Set(vals);
  const flag = uniq.size > 1 ? "  <-- DIFF" : "";
  if (uniq.size > 1) diffs++;
  console.log(k.padEnd(w) + " | " + vals.map((v) => String(v).slice(0, 28).padEnd(28)).join(" | ") + flag);
}
console.log(`\n${diffs} key(s) differ between the env files.`);
