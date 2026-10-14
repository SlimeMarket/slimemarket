import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * i18n integrity — the dictionary is one big hand-maintained object literal, so
 * a copy-paste slip silently ships wrong or duplicated text. Two classes have
 * already occurred in production:
 *
 *   1. Chinese text left inside the Russian block
 *      (`nav.rekber.desc` = "WL 和 P2P 监管")
 *   2. A `.desc` line duplicating its own label, so a nav item rendered the same
 *      word twice ("首页 / 首页", "Главная / Главная", "Каталог / Каталог")
 *
 * Both are invisible to type-checks and unit tests, and only surface when a
 * human reads the UI in that language.
 */
const SRC = readFileSync("public/i18n.jsx", "utf8").split("\n");

const BLOCKS = SRC.reduce((acc, line, i) => {
  const m = line.match(/^\s{2}(en|id|zh|ru)\s*:\s*\{/);
  if (m) acc.push({ lang: m[1], line: i + 1 });
  return acc;
}, [] as { lang: string; line: number }[]);

const langAt = (n: number) => {
  let cur = "?";
  for (const b of BLOCKS) if (b.line <= n) cur = b.lang;
  return cur;
};

const dict: Record<string, Record<string, string>> = {};
SRC.forEach((line, i) => {
  const lang = langAt(i + 1);
  if (lang === "?") return;
  const re = /['"]([A-Za-z0-9_.]+)['"]\s*:\s*['"]([^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    dict[lang] = dict[lang] || {};
    dict[lang][m[1]] = m[2];
  }
});

describe("i18n dictionary integrity", () => {
  it("parses all four language blocks", () => {
    expect(BLOCKS.map((b) => b.lang)).toEqual(["en", "id", "zh", "ru"]);
  });

  it("no Chinese characters leak into the en/id/ru blocks", () => {
    const CJK = /[\u4e00-\u9fff]/;
    const leaks: string[] = [];
    for (const [lang, d] of Object.entries(dict)) {
      if (lang === "zh") continue;
      for (const [k, v] of Object.entries(d)) {
        if (CJK.test(v)) leaks.push(`${lang} ${k} = ${JSON.stringify(v)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("no `.desc` entry merely repeats its own label", () => {
    const dupes: string[] = [];
    for (const [lang, d] of Object.entries(dict)) {
      for (const k of Object.keys(d)) {
        if (!k.endsWith(".desc")) continue;
        const base = k.slice(0, -5);
        if (d[base] && d[base] === d[k]) dupes.push(`${lang} ${base} = ${JSON.stringify(d[k])}`);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("every language defines the core nav labels", () => {
    // These render in the sidebar for every user, so a missing translation is
    // immediately visible as a raw key.
    const required = ["nav.beranda", "nav.storefront", "nav.rekber", "nav.discussion"];
    for (const lang of ["en", "id", "zh", "ru"]) {
      for (const key of required) {
        expect(dict[lang]?.[key], `${lang} kehilangan ${key}`).toBeTruthy();
      }
    }
  });

  /**
   * Newer surfaces lean on the `tr('key', 'English')` fallback, so a key that is
   * missing from id/zh/ru does NOT show up as a raw key — it silently renders in
   * English. That is invisible to every other check, which is why these prefixes
   * are pinned explicitly.
   *
   * Add a prefix here when a feature ships user-visible copy in more than one
   * language. Do not broaden it to "every key" — most of the dictionary is
   * English-fallback by design and that assertion would be noise.
   */
  it("cross-chain bridge copy is translated in every language", () => {
    const prefixes = ["af.cc", "rk.viaWl"];
    // `en` is intentionally excluded: its values live in the tr() call sites.
    const langs = ["id", "zh", "ru"];

    // Derive the key set from the blocks themselves so a newly added key cannot
    // be forgotten — if it exists in ANY translated block it must exist in all.
    const keys = new Set<string>();
    for (const lang of langs) {
      for (const k of Object.keys(dict[lang] ?? {})) {
        if (prefixes.some((p) => k.startsWith(p))) keys.add(k);
      }
    }
    expect(keys.size).toBeGreaterThan(20);

    const missing: string[] = [];
    for (const k of keys) {
      for (const lang of langs) {
        if (!dict[lang]?.[k]) missing.push(`${lang} ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
