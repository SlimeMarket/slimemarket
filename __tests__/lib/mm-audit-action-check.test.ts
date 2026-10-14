import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The `mm_audit_log.action` CHECK constraint must accept every value the app can
 * send it — and it stopped doing that once already.
 *
 * WHAT HAPPENED (migration 0092 fixes it): a CHECK constraint is re-declared by
 * dropping it and adding a new one, so the new list is the WHOLE truth. Anything
 * the author was not thinking about at that moment silently disappears — no
 * error, the constraint just gets narrower.
 *
 *   0072 added WL_DEAL_DELIVERED, WL_DEAL_DISPUTED, SLASH_COLLATERAL
 *   0074 added WL_DEAL_PAID, WL_DEAL_PAYMENT_CONFIRMED
 *   0083 re-declared the constraint and listed only SLASH_COLLATERAL
 *
 * Every WL deal audit write then failed the CHECK, went to the dead-letter
 * table, and had its throw swallowed by `.catch(() => {})` at the call site —
 * so requests returned 200 while the audit trail quietly lost every
 * delivered / paid / payment-confirmed / disputed event.
 *
 * This test reads the MIGRATIONS, not the database: it has to fail in CI, where
 * no Postgres is running, and it must catch the mistake at the commit that
 * introduces it.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

/** Every `"SOME_ACTION"` in the app's MmAuditAction union. */
function appActions(): string[] {
  const src = readFileSync(join(__dirname, "..", "..", "lib", "mm.ts"), "utf8");
  const block = src.match(/export type MmAuditAction =([\s\S]*?);/);
  if (!block) throw new Error("MmAuditAction union not found in lib/mm.ts");
  return [...new Set([...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]))].sort();
}

/**
 * The action list of the LAST `mm_audit_log_action_check` declaration across all
 * migrations, in filename order (which is the order they are applied).
 */
function lastConstraintActions(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let last: string[] | null = null;
  for (const f of files) {
    const src = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    // Match `add constraint mm_audit_log_action_check check (action in ( ... ))`
    // and take everything up to the closing `));`.
    const re = /add constraint mm_audit_log_action_check\s+check\s*\(\s*action\s+in\s*\(([\s\S]*?)\)\s*\)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      last = [...new Set([...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]))].sort();
    }
  }
  if (!last) throw new Error("no mm_audit_log_action_check declaration found in migrations");
  return last;
}

describe("mm_audit_log.action CHECK constraint", () => {
  it("the last migration declaration covers every action the app can send", () => {
    const declared = lastConstraintActions();
    const app = appActions();

    const missing = app.filter((a) => !declared.includes(a));
    expect(
      missing,
      `These MmAuditAction values are missing from the last mm_audit_log_action_check.\n` +
        `Every insert using one will fail the CHECK, be dead-lettered, and have its\n` +
        `throw swallowed — losing the audit entry silently.\n` +
        `Add them to the constraint (widen it; do not re-declare a narrower list).`,
    ).toEqual([]);
  });

  it("does not carry values the app never sends", () => {
    // A constraint wider than the app is harmless but hides typos: a misspelled
    // action would sit there looking supported forever.
    const declared = lastConstraintActions();
    const app = appActions();
    const extra = declared.filter((a) => !app.includes(a));
    expect(extra, `constraint allows values MmAuditAction never produces`).toEqual([]);
  });

  it("still declares the WL deal lifecycle actions restored by 0092", () => {
    // Named explicitly so a future re-declaration cannot quietly drop them again
    // — this is the exact regression that motivated the test.
    const declared = lastConstraintActions();
    for (const action of [
      "WL_DEAL_DELIVERED",
      "WL_DEAL_DISPUTED",
      "WL_DEAL_PAID",
      "WL_DEAL_PAYMENT_CONFIRMED",
    ]) {
      expect(declared, `${action} missing from the CHECK constraint`).toContain(action);
    }
  });

  it("keeps the constraint in step with the actor_type enum too", () => {
    // Same failure mode, same table: actor_type is a separate CHECK that a
    // future re-declaration could narrow just as easily.
    const src = readFileSync(join(__dirname, "..", "..", "lib", "mm.ts"), "utf8");
    const actorBlock = src.match(/export type AuditActorType =([\s\S]*?);/);
    if (!actorBlock) throw new Error("AuditActorType union not found in lib/mm.ts");
    const appActors = [...new Set([...actorBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]))].sort();

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    let declared: string[] | null = null;
    for (const f of files) {
      const s = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      const re = /add constraint mm_audit_log_actor_type_check\s+check\s*\(\s*actor_type\s+in\s*\(([\s\S]*?)\)\s*\)\s*;/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        declared = [...new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]))].sort();
      }
    }
    expect(declared, "no mm_audit_log_actor_type_check found").not.toBeNull();
    expect(appActors.filter((a) => !declared!.includes(a))).toEqual([]);
  });
});
