import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One chat thread per (type, order_id).
 *
 * WHAT HAPPENED: the get-or-create in /api/orders/[id]/chat and
 * /api/wl/deals/[id]/chat had no uniqueness guarantee and looked the thread up
 * with `.maybeSingle()`. Two concurrent first-opens (buyer and seller tapping the
 * same order at the same moment) each saw "no thread", each inserted one, and the
 * follow-up `.maybeSingle()` then errored with PGRST116 ("multiple rows
 * returned"). The handler read that error as "no data" → treated the lookup as
 * not-found → inserted a THIRD thread and served messages from that empty one.
 * The room looks empty and the conversation is split across rows nobody reads.
 *
 * THE INVARIANT (migration 0094):
 *   - a partial unique index on (type, order_id) where order_id is not null
 *   - existing duplicates collapsed WITHOUT losing messages (chat_messages.thread_id
 *     is ON DELETE CASCADE, so messages must be re-pointed before the thread row goes)
 *   - the handlers tolerate duplicates and treat 23505 as "another request won"
 *
 * Source-level assertions, because the bug is a wiring mistake: the DB behaviour
 * is what matters and it is pinned by the migration, not by a mocked client.
 */

const ROOT = join(__dirname, "..", "..");
const MIGRATION = join(ROOT, "supabase", "migrations", "0094_chat_thread_uniqueness.sql");

/** Strip // and /* *\/ comments so a doc block cannot satisfy an assertion. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Files that get-or-create a chat thread keyed by order_id. */
const THREAD_WRITERS = [
  join(ROOT, "app", "api", "orders", "[id]", "chat", "route.ts"),
  join(ROOT, "app", "api", "wl", "deals", "[id]", "chat", "route.ts"),
  join(ROOT, "lib", "order", "disputes.ts"),
];

describe("chat thread uniqueness (0094)", () => {
  it("declares a partial unique index on (type, order_id)", () => {
    const sql = readFileSync(MIGRATION, "utf8").toLowerCase();
    expect(sql).toMatch(/create unique index[^;]*chat_threads[^;]*\(type,\s*order_id\)/);
    expect(sql).toMatch(/where\s+order_id\s+is\s+not\s+null/);
  });

  it("re-points messages BEFORE deleting duplicate threads", () => {
    // chat_messages.thread_id is ON DELETE CASCADE, so deleting a duplicate
    // thread without moving its messages first destroys the conversation.
    const sql = readFileSync(MIGRATION, "utf8").toLowerCase();
    const repoint = sql.indexOf("update chat_messages");
    const drop = sql.indexOf("delete from chat_threads");
    expect(repoint, "migration never re-points chat_messages").toBeGreaterThan(-1);
    expect(drop, "migration never deletes duplicate threads").toBeGreaterThan(-1);
    expect(repoint, "messages must be re-pointed before the thread rows are deleted").toBeLessThan(drop);
  });

  for (const file of THREAD_WRITERS) {
    const rel = file.slice(ROOT.length + 1);

    it(`${rel}: does not use maybeSingle() for the thread lookup`, () => {
      // `.maybeSingle()` throws PGRST116 the moment a duplicate exists — which is
      // exactly what made the handler insert yet another thread.
      const src = stripComments(readFileSync(file, "utf8"));
      const bad = src.match(/\.eq\("order_id",\s*\w+\)\s*\.maybeSingle\(\)/);
      expect(bad, `${rel} looks the thread up with maybeSingle() — use .limit(1)`).toBeNull();
    });

    it(`${rel}: tolerates duplicates with limit(1)`, () => {
      const src = stripComments(readFileSync(file, "utf8"));
      expect(src).toMatch(/\.limit\(1\)/);
    });

    it(`${rel}: recovers when a concurrent insert wins the race (23505)`, () => {
      // Without this, the losing request 500s instead of returning the thread
      // the winner just created.
      const src = stripComments(readFileSync(file, "utf8"));
      expect(src, `${rel} does not handle unique_violation (23505)`).toContain("23505");
    });
  }
});
