import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the landing-page → storefront category contract.
 *
 * WHAT WENT WRONG (found 2026-10-11): the landing page's category cards carried
 * grouping ids (`digital`/`game`/`jasa`) that are NOT `products.category`
 * values, and `goStorefront` threw the category away and used the card's *label*
 * as a search query instead. So clicking "Game Products" searched for the
 * literal text "Game Products" and matched nothing. Separately the API tested
 * for a `"Semua"` sentinel while the storefront sends `"All"`, so `?cat=All`
 * filtered on `category = 'All'` and returned an empty catalog.
 *
 * Both were silent — no error, just an empty list. These assertions read the
 * source files and fail loudly if the two sides drift apart again.
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** `const CATEGORIES = ['All', 'Game Accounts', …];` */
function parseCategories(): string[] {
  const src = read("public/data.jsx");
  const m = src.match(/const CATEGORIES\s*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error("CATEGORIES not found in public/data.jsx");
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** The `cat:` field of every HOME_CATS entry. */
function parseHomeCatTargets(): Array<{ id: string; cat: string }> {
  const src = read("public/data2.jsx");
  const block = src.match(/const HOME_CATS\s*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("HOME_CATS not found in public/data2.jsx");
  return [...block[1].matchAll(/id:\s*'([^']+)'[\s\S]*?cat:\s*'([^']+)'/g)].map((x) => ({
    id: x[1],
    cat: x[2],
  }));
}

describe("storefront categories", () => {
  it("every landing category card maps to a real storefront category", () => {
    const categories = parseCategories();
    const home = parseHomeCatTargets();

    expect(home.length).toBeGreaterThan(0);
    for (const { id, cat } of home) {
      expect(
        categories.includes(cat),
        `HOME_CATS "${id}" targets "${cat}", which is not one of CATEGORIES: ${categories.join(", ")}`,
      ).toBe(true);
    }
  });

  it("landing cards do not send their i18n id as a category", () => {
    const categories = parseCategories();
    for (const { id, cat } of parseHomeCatTargets()) {
      // `digital`/`game`/`jasa` are i18n key suffixes, not categories.
      expect(cat).not.toBe(id);
      expect(categories.includes(id)).toBe(false);
    }
  });

  it("the API treats 'All' (and 'Semua') as the no-filter sentinel", () => {
    const src = read("lib/catalog/products.ts");
    // `All` is the storefront sentinel; `Semua` is the Indonesian spelling some
    // callers still send. Both mean "no filter" — treating either as a category
    // name returns an empty catalog.
    expect(src).toMatch(/\/\^\(all\|semua\)\$\/i/);
    expect(src).not.toMatch(/cat\s*[!=]==\s*"Semua"/);
    expect(src).not.toMatch(/eq\(\s*"category"\s*,\s*"Semua"\s*\)/);
  });

  it("the landing page passes the mapped category, not the label", () => {
    const src = read("public/landing.jsx");
    expect(src).toMatch(/onCat\(c\.cat,\s*''\)/);
    expect(src).not.toMatch(/onCat\(c\.id,\s*c\.label\)/);
  });

  it("goStorefront normalises the category before setting it", () => {
    const src = read("public/app.jsx");
    // 'Semua' (Indonesian for "All") used to be forwarded as a category name,
    // which the storefront compares against the English sentinel — so every
    // topbar search filtered out every product and returned "no results".
    expect(src).toMatch(/setStoreCat\(\s*!cat\s*\|\|\s*cat\s*===\s*'Semua'\s*\?\s*'All'\s*:\s*cat\s*\)/);
    // Both Storefront renders must receive it, or one of the two shells
    // (guest vs authed) silently loses the filter.
    const renders = src.match(/<Storefront[^>]*\/>/g) ?? [];
    expect(renders.length).toBeGreaterThanOrEqual(2);
    for (const r of renders) {
      expect(r, `Storefront render is missing cat: ${r}`).toContain("cat={storeCat}");
    }
  });
});
