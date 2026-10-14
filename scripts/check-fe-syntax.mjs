/**
 * Frontend syntax check for the `public/` CDN SPA.
 *
 * The SPA is plain `.jsx` transpiled in the BROWSER by Babel standalone — it is
 * never compiled by Next, so `tsc` cannot see it and a syntax error only shows
 * up at runtime as a blank page. This script is the only pre-flight gate.
 *
 * replaced a naive brace/paren/bracket COUNTER with esbuild's real
 * parser. The counter reported 6 false-positive errors (productdetail,
 * orderroom, orders, sellerdash, admin, app) because it did not understand
 * regex literals, template-literal `${}` nesting, JSX text, or block comments.
 * A gate that cries wolf is worse than no gate — it trains you to ignore it.
 *
 * Usage: node scripts/check-fe-syntax.mjs
 * Exit code: 0 = all parsed, 1 = at least one file failed.
 */
import { readFileSync } from "node:fs";
import * as esbuild from "esbuild";

/** Kept in the same order as the <script type="text/babel"> tags in index.html. */
const FILES = [
  "data.jsx", "data2.jsx", "ui.jsx", "i18n.jsx", "router.jsx", "storefront.jsx",
  "landing.jsx", "productdetail.jsx", "orderroom.jsx", "orders.jsx", "rekber.jsx",
  "wl.jsx", "escrow.jsx", "balance.jsx", "chatdm.jsx", "globalchat.jsx",
  "format.jsx", "income-chart.jsx", "seller.jsx", "sellerdash.jsx", "admin.jsx",
  "mm.jsx", "auth.jsx", "refresh-session.jsx", "ucw-helper.jsx", "pin-status-badge.jsx",
  "pin-management.jsx", "userdash.jsx", "app-kit-helper.jsx", "app.jsx",
];

let failed = 0;
let checked = 0;

for (const f of FILES) {
  const path = `public/${f}`;
  let code;
  try {
    code = readFileSync(path, "utf8");
  } catch {
    console.log(`MISSING ${f}`);
    failed++;
    continue;
  }

  const lines = code.split(/\r?\n/);
  try {
    await esbuild.transform(code, { loader: "jsx" });
    checked++;
    console.log(`OK    ${f} (${lines.length} lines)`);
  } catch (e) {
    failed++;
    console.log(`ERROR ${f}`);
    for (const err of e.errors ?? []) {
      const line = err.location?.line ?? null;
      console.log(`      ${err.text}  (line ${line ?? "?"}, col ${err.location?.column ?? "?"})`);
      if (line && lines[line - 1] !== undefined) {
        console.log(`      > ${lines[line - 1].trim().slice(0, 150)}`);
      }
    }
  }
}

console.log("");
if (failed === 0) {
  console.log(`All ${checked} frontend files parse OK.`);
  process.exit(0);
}
console.log(`${failed} files with problems (${checked} OK).`);
process.exit(1);
