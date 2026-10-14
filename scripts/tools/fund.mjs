const BASE = "http://localhost:3000";
const email = process.argv[2] || "testbuyer@slimemarket.app";
const role = process.argv[3] || "Buyer";
const amount = process.argv[4] || "5";

const r = await fetch(`${BASE}/api/auth/dev-login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, role }),
});
if (!r.ok) {
  console.error("dev-login failed", r.status, await r.text());
  process.exit(1);
}
const jar = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const f = await fetch(`${BASE}/api/wallet/dev/faucet`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: jar },
  body: JSON.stringify({ amountUsdc: amount }),
});
console.log("faucet HTTP", f.status, JSON.stringify(await f.json()).slice(0, 300));

const w = await fetch(`${BASE}/api/wallet`, { headers: { cookie: jar } });
console.log("wallet  HTTP", w.status, JSON.stringify(await w.json()).slice(0, 400));
