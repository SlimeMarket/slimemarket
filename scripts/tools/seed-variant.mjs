const BASE = "http://localhost:3000";

const res = await fetch(`${BASE}/api/auth/dev-login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "testseller@slimemarket.app", role: "Seller" }),
});
const jar = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const payload = {
  name: "Variant Flow Item " + Date.now(),
  category: "Digital Products",
  delivery: "instant",
  price: 1,
  desc: "Per-variant stock product for flow testing",
  variants: [
    { label: "Default", price: 1, stockItems: ["vk-1", "vk-2", "vk-3", "vk-4", "vk-5"] },
  ],
};

const r = await fetch(`${BASE}/api/my/products`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: jar },
  body: JSON.stringify(payload),
});
console.log("HTTP", r.status, JSON.stringify(await r.json()).slice(0, 400));
