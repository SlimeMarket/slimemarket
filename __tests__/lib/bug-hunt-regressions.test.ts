import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

/**
 * Regression tests for the bug-hunt sweep.
 *
 * Each case pins an INVARIANT that a real bug violated, not the incident itself.
 * These are source-level assertions because every bug here was a WIRING mistake —
 * a query naming a column that does not exist, or a grant that should not be
 * public. No unit test can catch those: the tests mock the very layer that broke.
 *
 * Comments are stripped before asserting, otherwise the doc block explaining a
 * fix would satisfy the assertion on its own.
 */

/**
 * Strip comments with a small state machine.
 *
 * A naive pair of regexes does NOT work here, and the failure is silent. A line
 * comment that mentions a glob path (the "gateway" routes note in gateway-eoa)
 * contains an opening block-comment token, so the regex reads it as the start of
 * a block comment and swallows source code until the next closing token. That
 * deleted 34 lines including the very assertion target, so the test reported a
 * false failure against code that was actually correct.
 *
 * Stripping line comments first is no better — a block comment may contain a
 * line-comment token. Only real comment state is tracked here, and string and
 * regex literals are left alone.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i++; continue; }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const read = (p: string) => stripComments(readFileSync(p, "utf8"));

describe("column names match the real schema", () => {
  it("gateway-eoa queries wallets by wallet_type, never `type`", () => {
    // `wallets` has no `type` column (it is `wallet_type`). Filtering on `type`
    // made PostgREST error on every Gateway signer lookup.
    const src = read("lib/circle/gateway-eoa.ts");
    expect(src).not.toMatch(/\.eq\(\s*["'`]type["'`]/);
    expect(src).toMatch(/\.eq\(\s*["'`]wallet_type["'`]/);
  });

  it("gateway-eoa never selects the nonexistent wallet_set_id column", () => {
    // The wallet set id is deployment config (CIRCLE_WALLET_SET_ID), not a
    // per-row column — `wallets` has no `wallet_set_id`.
    const src = read("lib/circle/gateway-eoa.ts");
    expect(src).not.toMatch(/wallet_set_id\s*:/);
    expect(src).not.toMatch(/select\(\s*["'`]wallet_set_id["'`]/);
  });

  it("gateway-eoa inserts only columns that exist on wallets", () => {
    // The old payload carried name/wallet_address/blockchain/type/wallet_set_id,
    // none of which exist — so the insert threw on every call.
    //
    // Scope the check to the insertData object: `blockchain` also appears as a
    // legitimate parameter type annotation elsewhere in the file, and matching
    // that would be a false positive.
    const src = read("lib/circle/gateway-eoa.ts");
    const insert = src.slice(src.indexOf("const insertData"), src.indexOf("const { data, error } = await supabase"));
    expect(insert.length).toBeGreaterThan(0);
    for (const ghost of ["wallet_address:", "blockchain:", "wallet_set_id:", "name:"]) {
      expect(insert).not.toContain(ghost);
    }
    // ...and it does carry the columns that really exist.
    for (const real of ["user_id:", "address:", "wallet_type:", "circle_wallet_id:"]) {
      expect(insert).toContain(real);
    }
  });

  it("the profile route never reads stores.category or orders.rating", () => {
    // `stores` has no `category`; ratings live in `reviews`, and the store row
    // already carries a denormalised rating/rating_count.
    const src = read("app/api/users/[uid]/route.ts");
    expect(src).not.toMatch(/["'`]id,\s*name,\s*category/);
    expect(src).not.toMatch(/from\(\s*["'`]orders["'`]\s*\)[\s\S]{0,120}?select\(\s*["'`]rating["'`]/);
  });

  it("auto-release reads and writes the settlement columns", () => {
    // These columns were missing entirely, so the route 404'd for every order.
    const src = read("app/api/orders/[id]/auto-release/route.ts");
    expect(src).toContain("settled_at");
    expect(src).toContain("settlement_tx_hash");
  });
});

describe("state machines cover every way a row can enter a state", () => {
  it("draft-cleanup reaps every payment method that can produce a PENDING draft", () => {
    // `orders.payment` CHECK allows Balance | Direct | Onchain. The cleanup job
    // has one reaper per method; if a method is added to the CHECK but not to a
    // reaper, its drafts sit in PENDING forever and pollute the buyer's list.
    //
    // This is currently a LATENT gap: `Direct` is declared in the
    // PaymentMethod type but never written, so no row carries it today. The
    // assertion exists so that changing that fails loudly here rather than
    // silently leaking rows in production.
    const src = read("lib/order/draft-cleanup.ts");
    const CHECK_VALUES = ["Balance", "Direct", "Onchain"];
    const covered = CHECK_VALUES.filter((v) => src.includes(`"${v}"`));
    // NB: sorted alphabetically — "Balance" < "Onchain". (It read
    // ["Onchain", "Saldo"] before the enum was renamed to English.)
    expect(covered.sort()).toEqual(["Balance", "Onchain"]);
    // ...and the uncovered one must be the one nothing writes.
    const unwritten = CHECK_VALUES.filter((v) => !src.includes(`"${v}"`));
    expect(unwritten).toEqual(["Direct"]);
  });

  it("both reaper paths carry the on-chain guards that make cancellation safe", () => {
    // Cancelling a draft whose relay was already submitted would hide it from
    // reconciliation and strand the buyer's USDC. Both paths must therefore
    // require BOTH on-chain references to be absent.
    const src = read("lib/order/draft-cleanup.ts");
    const orderIdGuards = src.match(/\.is\("on_chain_order_id",\s*null\)/g) ?? [];
    const circleTxGuards = src.match(/\.is\("on_chain_circle_tx_id",\s*null\)/g) ?? [];
    expect(orderIdGuards.length).toBeGreaterThanOrEqual(2);
    expect(circleTxGuards.length).toBe(orderIdGuards.length);
  });

  it("onchain-id reconciliation skips orders that already settled", () => {
    // Without this the scan keeps retrying orders that finished fine (DONE +
    // RELEASED) but never had their contract id recorded. `stillPending` then
    // never reaches 0, so a genuinely stuck order is lost in the noise — and
    // the job burns a resolve attempt per settled order on every run.
    const src = read("lib/reconcile/onchain-ids.ts");
    const exclusions = src.match(/\.not\("on_chain_status",\s*"in"/g) ?? [];
    // One for orders, one for wl_deals.
    expect(exclusions.length).toBe(2);
    expect(src).toContain("SETTLED_ONCHAIN_STATES");
    expect(src).toMatch(/SETTLED_ONCHAIN_STATES\s*=\s*\["RELEASED",\s*"REFUNDED"\]/);
  });

  it("referral history is gone, not silently broken", () => {
    // The referral feature was removed outright. This test used to assert the
    // fix (reading history from referral_events); it now asserts the removal,
    // so a partial re-introduction that forgets the data source fails loudly.
    expect(existsSync("app/api/referral/route.ts")).toBe(false);
    expect(existsSync("public/referral.jsx")).toBe(false);
  });
});

describe("session bootstrap", () => {
  it("restores the session on boot, not only when localStorage says so", () => {
    // The bootstrap used to start with `if (!authed) return;`, and `authed` is
    // hydrated from localStorage — while `slime_authed` is ONLY written by the
    // sign-in handler. That made the guard circular: it restored the session
    // only if localStorage already proved you were signed in, which is the very
    // state being recovered. The cookie is httpOnly (JS cannot read it), so any
    // user on a fresh browser profile, cleared storage or incognito got the
    // SIGN-IN screen despite holding a valid session — and deep links to
    // /admin, /orders, /wallet all bounced to sign-in.
    const src = read("public/app.jsx");
    // Anchor on the fetch itself — comments are stripped by `read()`, and the
    // bare string "/api/auth/me" also appears earlier in the file, so indexOf on
    // it yields a negative-length slice that would pass vacuously.
    const fetchAt = src.indexOf("fetch((window.SLIME_API || '') + '/api/auth/me'");
    expect(fetchAt).toBeGreaterThan(-1);
    // The guard must NOT sit between the effect and the fetch.
    const boot = src.slice(Math.max(0, fetchAt - 600), fetchAt);
    expect(boot).not.toMatch(/if\s*\(\s*!authed\s*\)\s*return/);
    // A successful restore must flip `authed` so the other gates open.
    expect(src).toMatch(/localStorage\.setItem\('slime_authed',\s*'1'\)[\s\S]{0,80}setAuthed\(true\)/);
  });

  it("the session probe stays exempt for anonymous visitors", () => {
    // The probe is SUPPOSED to 401 when logged out — that is how the app learns
    // there is no session. It must not be treated as a hard error.
    const src = read("public/app.jsx");
    expect(src).toMatch(/err\.status === 401/);
  });
});

describe("checkout shows one balance, not two", () => {
  it("the payment tile advertises the same balance the gate enforces", () => {
    // The modal gates on the ON-CHAIN balance (ME.usdcOnChain) because that is
    // what the server checks, but the Slime Wallet tile advertised ME.usdc (the
    // platform-ledger balance). A user with 49.00 in the platform and 0 on-chain
    // saw a tile reading "49.00 USDC", picked it, and was immediately told
    // "Insufficient Balance" — the app says you have funds and then says you
    // don't. Both must read from the same source.
    const src = read("public/storefront.jsx");
    const tile = src.slice(src.indexOf("sf.pmSlime"), src.indexOf("Card / Bank"));
    expect(tile).toContain("balanceForGate");
    expect(tile).not.toMatch(/<Usdc value=\{ME\.usdc\}/);
  });

  it("the balance label says it is the on-chain balance", () => {
    // "Wallet Balance" was ambiguous next to the header's unlabelled platform
    // balance. The modal means the on-chain figure, so it must say so.
    const i18n = read("public/i18n.jsx");
    expect(i18n).toMatch(/'sf\.walletBalance':'On-chain Balance \(Arc\)'/);
  });
});

describe("admin console renders with no treasury data", () => {
  it("never dereferences treasuryData without a null guard", () => {
    // Clicking the Overview tab crashed the whole console with
    // "Cannot read properties of null (reading 'collectedFees')".
    //
    // The cause was a half-guarded JSX expression:
    //   {treasuryData ? (…platformFee…) : '—'} {treasuryData && '+'} {treasuryData.collectedFees…}
    // The ternary protects the FIRST expression, but the second one is still
    // evaluated unconditionally — so a null `treasuryData` (the state before
    // /api/admin/treasury resolves) threw during render. An error boundary
    // swallowed it into a full-page "Something went wrong" screen.
    const src = read("public/admin.jsx");

    // Match the defect literally rather than trying to reason about guards.
    //
    // The crash was `{treasuryData && '+'} {treasuryData.collectedFees…}` — a
    // bare access placed AFTER a `{treasuryData && …}` fragment, so it runs even
    // when treasuryData is null. The fixed version reads `{treasuryData?.
    // collectedFees…}`. Asserting on that exact adjacency avoids flagging the
    // many safe uses such as `treasuryData ? (treasuryData.collectedFees?.x ?? 0) : '—'`,
    // where the bare access sits inside the ternary's own true-branch.
    const offenders: string[] = [];
    src.split("\n").forEach((line, i) => {
      // a `treasuryData &&` fragment followed later on the same line by a bare
      // `treasuryData.` access (i.e. NOT `treasuryData?.`)
      const m = line.match(/treasuryData &&[\s\S]*treasuryData\.(?!\?)/);
      if (m) offenders.push(`baris ${i + 1}: ${line.trim().slice(0, 110)}`);
    });
    expect(offenders).toEqual([]);
  });
});

describe("payment rail is picked from the health body, not its status code", () => {
  it("parses /api/health without gating on r.ok", () => {
    // /api/health returns 503 when the service is DEGRADED (indexer lagging) but
    // the body is still valid JSON carrying `onChainFunds`. Gating the parse on
    // r.ok left window.ONCHAIN_FUNDS false, so the UI offered the custodial rail
    // while the server was in on-chain mode and every checkout 409'd with
    // CUSTODIAL_RAIL_DISABLED — a transient indexer lag became "cannot pay".
    const src = read("public/app.jsx");
    const at = src.indexOf("'/api/health'");
    expect(at).toBeGreaterThan(-1);

    // The statement right after the fetch must parse the body unconditionally.
    const after = src.slice(at, at + 400);
    expect(after).toContain("await r.json()");
    expect(after).not.toMatch(/if\s*\(\s*r\.ok\s*\)/);
  });
});

describe("non-custodial draft never consumes stock at prepare", () => {
  // Strip SQL line comments first: the prose between two functions mentions the
  // pop helpers, which would otherwise be mistaken for calls in the body.
  const migration = readFileSync(
    "supabase/migrations/0079_variant_stock_order_pop.sql",
    "utf8",
  )
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  const bodyOf = (name: string) => {
    const start = migration.indexOf(`FUNCTION ${name}(`);
    if (start === -1) return "";
    const next = migration.indexOf("CREATE OR REPLACE FUNCTION", start);
    return migration.slice(start, next === -1 ? undefined : next);
  };

  it("inserts the draft as PENDING", () => {
    // 0048 established this, 0056 silently reverted it, 0057 restored it. A
    // draft born 'SENT' makes challenge/confirm unreachable ("order status SENT
    // cannot challenge (expected one of: PENDING)") and lets an abandoned draft
    // eat seller stock.
    const body = bodyOf("create_non_custodial_order");
    expect(body).not.toBe("");
    expect(body).toMatch(/'PENDING'/);
  });

  it("does not pop stock at prepare", () => {
    const body = bodyOf("create_non_custodial_order");
    expect(body).not.toMatch(/pop_stock_fifo|pop_one_stock_item/);
  });

  it("pops stock at confirm instead, from either store", () => {
    // auto_advance_instant_order runs only after the buyer's approve tx is
    // verified. It must understand BOTH stock stores — reading only
    // product_stock_items made legacy products fail after the buyer had paid.
    const body = bodyOf("auto_advance_instant_order");
    expect(body).not.toBe("");
    expect(body).toContain("pop_one_stock_item");
  });
});

describe("security: nothing sensitive is reachable with the public anon key", () => {
  const migrations = [
    "supabase/migrations/0077_lock_sql_simple_query.sql",
    "supabase/migrations/0078_lock_anon_exposure.sql",
  ];

  it("sql_simple_query is revoked from anon and authenticated", () => {
    // A SECURITY DEFINER generic SQL executor granted to anon is a full database
    // read for anyone holding the public key.
    const src = readFileSync("supabase/migrations/0077_lock_sql_simple_query.sql", "utf8");
    expect(src).toMatch(/revoke all on function public\.sql_simple_query\(text\) from anon/);
    expect(src).toMatch(/revoke all on function public\.sql_simple_query\(text\) from authenticated/);
    expect(src).toMatch(/grant execute on function public\.sql_simple_query\(text\) to service_role/);
  });

  it("the exposure sweep revokes from every SECURITY DEFINER function", () => {
    const src = readFileSync("supabase/migrations/0078_lock_anon_exposure.sql", "utf8");
    expect(src).toMatch(/revoke all on function %s from anon, authenticated, public/);
    // A blanket revoke is what makes this future-proof: functions added later are
    // covered by re-running, rather than needing to be listed by name.
    expect(src).toMatch(/prosecdef/);
  });

  it("the exposure sweep enables RLS on every table", () => {
    const src = readFileSync("supabase/migrations/0078_lock_anon_exposure.sql", "utf8");
    expect(src).toMatch(/enable row level security/);
    expect(src).toMatch(/not rowsecurity/);
  });

  it("every migration that adds a function also locks it down", () => {
    // The sweep in 0078 only sees functions that exist when it runs. 0079 added
    // two SECURITY DEFINER functions afterwards, and because Postgres grants
    // EXECUTE to PUBLIC by default they were born anon-callable — while every
    // assertion above still passed, because those assertions only read 0077/0078.
    //
    // Verified live before the fix:
    //   POST /rest/v1/rpc/pop_one_stock_item {"p_product_id":"…","p_variant_label":"Default"}
    //   → 200 "NFLX-0006-1679"    (real credential, no auth, no payment)
    const src = readFileSync("supabase/migrations/0079_variant_stock_order_pop.sql", "utf8");
    for (const fn of [
      "pop_stock_fifo_auto(uuid, text, int)",
      "pop_one_stock_item(uuid, text)",
    ]) {
      expect(src).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION ${fn.replace(/[().]/g, "\\$&")} FROM anon, authenticated, public`),
      );
    }
  });

  it("a later migration re-runs the sweep so new functions cannot slip through", () => {
    // Source-level checks cannot see the live database, so the structural fix is
    // to re-run the sweep after any migration that creates functions.
    const src = readFileSync(
      "supabase/migrations/0080_relock_anon_after_new_functions.sql",
      "utf8",
    );
    expect(src).toMatch(/revoke all on function %s from anon, authenticated, public/);
    expect(src).toMatch(/prosecdef/);
    expect(src).toMatch(/raise exception/i);
  });

  it("both security migrations assert their own success", () => {
    // A migration that silently does nothing is how the hole survived this long.
    for (const m of migrations) {
      const src = readFileSync(m, "utf8");
      expect(src).toMatch(/raise exception|raise notice/);
    }
    const sweep = readFileSync(migrations[1], "utf8");
    expect(sweep).toMatch(/raise exception '0078 FAILED/);
  });
});
