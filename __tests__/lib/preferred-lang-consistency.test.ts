import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { PREFERRED_LANGS } from "@/lib/types";

/**
 * `preferred_lang` is declared in THREE places that have to agree, and they
 * drifted apart once:
 *
 *   1. `LANGS` in public/i18n.jsx          — the languages the switcher offers
 *   2. `PreferredLang` in lib/types.ts     — the union the server accepts
 *   3. `users_preferred_lang_check` (DB)   — the values Postgres will store
 *
 * The UI shipped a Russian button while (2) and (3) both stopped at `zh`. It
 * stayed invisible because the choice was never sent to the server at all —
 * `setLang` only wrote localStorage — so the constraint was never exercised and
 * every user's preference reset on a new device.
 *
 * Migration 0093 fixed the DB and the write path landed with it. These
 * assertions keep the three in step so the next language cannot half-ship.
 */

const ROOT = join(__dirname, "..", "..");

/** Language ids offered by the switcher. */
function uiLangs(): string[] {
  const src = readFileSync(join(ROOT, "public", "i18n.jsx"), "utf8");
  const block = src.match(/const LANGS\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error("LANGS not found in public/i18n.jsx");
  return [...block[1].matchAll(/id:\s*'([a-z]{2})'/g)].map((m) => m[1]);
}

/** Values the LAST `users_preferred_lang_check` declaration accepts. */
function dbLangs(): string[] {
  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  let last: string[] | null = null;
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    const re = /add constraint users_preferred_lang_check\s+check\s*\(\s*preferred_lang\s+in\s*\(([\s\S]*?)\)\s*\)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      last = [...new Set([...m[1].matchAll(/'([a-z]{2})'/g)].map((x) => x[1]))].sort();
    }
  }
  if (!last) throw new Error("no users_preferred_lang_check found in migrations");
  return last;
}

describe("preferred_lang consistency", () => {
  it("every language the UI offers is accepted by the server type", () => {
    const ui = uiLangs();
    expect(ui.length).toBeGreaterThan(1);
    const missing = ui.filter((l) => !(PREFERRED_LANGS as readonly string[]).includes(l));
    expect(
      missing,
      `The switcher offers ${missing.join(", ")} but PreferredLang rejects it — ` +
        `selecting it would 400 on save.`,
    ).toEqual([]);
  });

  it("every language the UI offers is allowed by the DB constraint", () => {
    const ui = uiLangs();
    const db = dbLangs();
    const missing = ui.filter((l) => !db.includes(l));
    expect(
      missing,
      `The switcher offers ${missing.join(", ")} but users_preferred_lang_check ` +
        `rejects it — saving the preference would fail the CHECK.`,
    ).toEqual([]);
  });

  it("the DB constraint and the server type agree exactly", () => {
    // A constraint wider than the type is harmless but hides typos; narrower is
    // a 500 waiting to happen. They should be the same set.
    expect([...dbLangs()].sort()).toEqual([...(PREFERRED_LANGS as readonly string[])].sort());
  });

  it("Russian is present — the specific value that was missing", () => {
    expect(uiLangs()).toContain("ru");
    expect(PREFERRED_LANGS as readonly string[]).toContain("ru");
    expect(dbLangs()).toContain("ru");
  });

  it("the switcher actually persists the choice instead of only storing it locally", () => {
    // The whole reason the gap went unnoticed. If setLang stops calling the API,
    // the preference silently becomes device-local again.
    const src = readFileSync(join(ROOT, "public", "i18n.jsx"), "utf8");
    const fn = src.match(/const setLang = \(l\) => \{([\s\S]*?)\n\};/);
    expect(fn, "setLang not found").not.toBeNull();
    expect(fn![1]).toMatch(/\/api\/me/);
    expect(fn![1]).toMatch(/preferred_lang/);
    expect(fn![1]).toMatch(/localStorage/); // still the offline fallback
  });
});
