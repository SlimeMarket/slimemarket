/**
 * wl-ui-staff.mjs — click a STAFF-ONLY button (Release / Refund / Slash) in the
 * deal room, as an Admin, through the real UI.
 *
 * These are the buttons an admin uses to settle a deal. They render only when
 * `isStaff` is true, so this also checks that the staff branch is reachable —
 * the same class of bug as the buyer/seller seat check that hid every action
 * button for everyone.
 *
 * Usage:
 *   node scripts/tools/wl-ui-staff.mjs --session <admin storageState> \
 *     --deal <uuid> --button "Release Funds to Seller"
 */
import { chromium } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sessionPath = arg("session");
const dealId = arg("deal");
const buttonLabel = arg("button", "Release Funds to Seller");
const email = arg("email", "rimuru@slimemarket.app");
const PIN = arg("pin", "123456");
if (!dealId) { console.error("--deal <uuid> required"); process.exit(2); }

const SHOT_DIR = path.join(REPO, ".secrets", "shots");
mkdirSync(SHOT_DIR, { recursive: true });

let failed = 0;
const log = (ok, name, detail = "") => {
  console.log(`  ${ok === null ? "\u2022" : ok ? "\u2713" : "\u2717"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok === false) failed++;
};

const browser = await chromium.launch();
let ctx;
if (sessionPath && existsSync(sessionPath)) {
  const wrapper = JSON.parse(readFileSync(sessionPath, "utf8"));
  let state;
  if (wrapper.storageStatePath) {
    const real = path.isAbsolute(wrapper.storageStatePath) ? wrapper.storageStatePath : path.join(REPO, wrapper.storageStatePath);
    state = JSON.parse(readFileSync(real, "utf8"));
  } else state = wrapper.storageState ?? wrapper;
  ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
  log(null, "using saved session", sessionPath);
} else {
  // Admin can authenticate with dev-login in this environment.
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const r = await ctx.request.post(`${BASE}/api/auth/dev-login`, { data: { email } });
  log(r.ok(), `dev-login ${email}`, String(r.status()));
}
const page = await ctx.newPage();
page.on("dialog", (d) => {
  console.log(`  dialog: type=${d.type()} message="${d.message().slice(0, 60)}"`);
  d.accept(PIN).catch((e) => console.log("  dialog accept failed:", String(e).slice(0, 80)));
});

// The deal-room staff buttons mint their own token: when no X-Admin-Token is
// present the app prompts for the Admin PIN via window.prompt, so the dialog
// handler answers it with the PIN. No console pre-unlock is needed.
// Log EVERY api call so a missing one is visible (a filtered listener hides the
// very thing you need when the call never happens).
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("/api/") && !/\/api\/health|\/api\/products|\/api\/notifications/.test(u)) {
    console.log(`  → ${r.method()} ${u.replace(BASE, "")}`);
  }
});
page.on("response", async (r) => {
  const u = r.url();
  if (/\/release|\/refund|\/slash|\/dispute|\/escape-hatch|\/admin\/verify/.test(u) && !/assets|\.js/.test(u)) {
    let b = "";
    try { b = (await r.text()).slice(0, 170); } catch {}
    log(r.ok(), `${r.status()} ${u.replace(BASE, "")}`, b);
  }
});
// Also surface a hard failure: the app shows it via notify(), which lands in the
// page text, but a thrown error before any request is otherwise invisible.
page.on("requestfailed", (r) => {
  const u = r.url();
  if (/\/wl\/deals/.test(u)) log(false, `request failed ${u.replace(BASE, "")}`, String(r.failure()?.errorText).slice(0, 90));
});

await page.goto(`${BASE}/escrow/${dealId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
// Wait for the ACTUAL deal room, not just any text. The page chrome alone is
// >400 chars, so a length-based check breaks out before the room resolves and the
// buttons look missing. Key on the deal id appearing plus the loading state gone.
let txt = "";
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  if (txt.includes(dealId.slice(0, 8)) && !/Loading deal/.test(txt)) break;
}
log(!/Loading deal/.test(txt) && txt.includes(dealId.slice(0, 8)), "deal room rendered");
// ME.role is set by the /api/auth/me boot call, which can resolve after the room
// renders — poll instead of reading once, or a staff user reads as "Member".
let role = "(unknown)";
for (let i = 0; i < 20; i++) {
  role = await page.evaluate(() => (window.ME && window.ME.role) || "(none)");
  if (role === "Admin" || role === "MM") break;
  await page.waitForTimeout(1000);
}
log(role === "Admin" || role === "MM", "viewer is staff", `role=${role}`);

const labels = await page.evaluate(() =>
  [...document.querySelectorAll("button")].map((el) => (el.innerText || "").trim().replace(/\s+/g, " ")).filter(Boolean),
);
console.log("  staff buttons visible:", JSON.stringify(labels.filter((l) => /Release|Refund|Fraud|Escape|Force/i.test(l))));

const btn = page.getByRole("button", { name: new RegExp(buttonLabel, "i") }).first();
const has = (await btn.count()) > 0;
log(has, `button "${buttonLabel}" present`);
if (has) {
  await btn.click({ timeout: 10_000 }).catch((e) => log(false, "click failed", String(e).slice(0, 110)));
  await page.waitForTimeout(30000);
}

await page.screenshot({ path: path.join(SHOT_DIR, "wl-ui-staff.png"), fullPage: true }).catch(() => {});
const after = await page.evaluate(async (id) => {
  const r = await fetch(`/api/wl/deals/${id}`, { credentials: "include" });
  return r.ok ? await r.json() : null;
}, dealId);
log(null, "deal after", `status=${after?.status}`);

await browser.close();
console.log(`\n${failed === 0 ? "OK" : `${failed} step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
