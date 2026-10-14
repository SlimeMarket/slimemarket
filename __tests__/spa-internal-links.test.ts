import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard: every internal SPA link must resolve to a real route.
 *
 * WHY: `public/auth.jsx` and `public/pin-management.jsx` both linked to
 * `/forgot-pin`, which `public/router.jsx` has NO case for — so parsePath fell
 * through to `{ view: 'notfound' }` and the user hit a dead page. The SPA is
 * Babel-in-browser, so a bad path is invisible to tsc and to esbuild parsing:
 * nothing catches it until a human clicks the button.
 *
 * This test derives the route table from router.jsx and cross-checks every
 * `location.href = '/…'` target against it.
 */

const PUBLIC = join(process.cwd(), "public");

/** Segments parsePath() actually understands (the `case` labels in its switch). */
function routerSegments(): Set<string> {
  const src = readFileSync(join(PUBLIC, "router.jsx"), "utf8");
  const start = src.indexOf("function parsePath");
  expect(start, "parsePath() not found in router.jsx").toBeGreaterThan(-1);
  // Slice to the end of the switch block (first closing brace at column 0 after start).
  const rest = src.slice(start);
  const end = rest.indexOf("\n}");
  const body = end > 0 ? rest.slice(0, end) : rest;
  const segs = new Set<string>();
  for (const m of body.matchAll(/case\s+'([a-z0-9-]*)'/gi)) segs.add(m[1]);
  return segs;
}

/** Every `location.href = '/…'` target found in the public/*.jsx SPA files. */
function referencedTargets(): { file: string; target: string }[] {
  const files = readdirSync(PUBLIC).filter((f) => f.endsWith(".jsx"));
  const re = /(?:window\.)?location\.href\s*=\s*['"`]\/([^'"`?#]*)/g;
  const out: { file: string; target: string }[] = [];
  for (const f of files) {
    const src = readFileSync(join(PUBLIC, f), "utf8");
    for (const m of src.matchAll(re)) out.push({ file: f, target: m[1] });
  }
  return out;
}

/** Static assets (/config.js, /app.jsx …) and API calls are not SPA routes. */
function isSpaRoute(target: string): boolean {
  if (target.startsWith("api/")) return false;
  if (/\.[a-z0-9]+$/i.test(target)) return false; // has a file extension
  return true;
}

describe("SPA internal links", () => {
  it("every location.href target resolves to a real router view", () => {
    const segs = routerSegments();
    const broken: string[] = [];

    for (const { file, target } of referencedTargets()) {
      if (!isSpaRoute(target)) continue;
      const seg = target.split("/").filter(Boolean)[0] ?? "";
      if (seg === "") continue; // root
      if (!segs.has(seg)) {
        broken.push(`${file} → /${target}  (router.jsx has no case '${seg}')`);
      }
    }

    expect(broken, `Dead internal links:\n${broken.join("\n")}`).toHaveLength(0);
  });

  it("the known-good recovery links are present (sanity)", () => {
    // Guards against the test silently passing because the regex matched nothing.
    const targets = referencedTargets().map((t) => t.target);
    expect(targets.length, "no internal links found — regex drifted?").toBeGreaterThan(0);
    expect(targets).toContain("refresh-session");
  });
});
