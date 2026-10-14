const BASE = "http://localhost:3000";
const login = async (email, role) => {
  const r = await fetch(`${BASE}/api/auth/dev-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) });
  return r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
};
const seller = await login("testseller@slimemarket.app", "Seller");
const buyer = await login("testbuyer@slimemarket.app", "Buyer");

const pr = await fetch(`${BASE}/api/my/products`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie: seller },
  body: JSON.stringify({
    name: "Probe Item " + Date.now(), category: "Digital Products", delivery: "instant", price: 1,
    desc: "probe product for prepare shape",
    variants: [{ label: "Default", price: 1, stockItems: ["pk-1","pk-2","pk-3"] }],
  }),
});
const prod = await pr.json();

const r = await fetch(`${BASE}/api/orders/checkout/prepare`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie: buyer },
  body: JSON.stringify({ productId: prod.id, variantLabel: "Default", qty: 1 }),
});
console.log("STATUS", r.status);
console.log(JSON.stringify(await r.json(), null, 2).slice(0, 2000));
