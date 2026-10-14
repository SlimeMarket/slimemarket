/**
 * Functional smoke test for A1 (WTB listings) and D3 (proof of payment).
 *
 * These two features are pure DB logic — no chain involved — so they are tested
 * against the real RPCs rather than through HTTP (which would need a staff PIN).
 *
 * A1 is the risky one: `create_wl_deal` now decides who is buyer and who is
 * seller from the listing's `side`. Getting that backwards would silently create
 * deals with the roles inverted, which is invisible until money moves.
 *
 * Usage: node --env-file=.env.local --import tsx scripts/smoke-a1-d3.ts
 */
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

let passed = 0, failed = 0;
const ok = (n: string, d = "") => { passed++; console.log(`  ✓ ${n}${d ? ` — ${d}` : ""}`); };
const bad = (n: string, d = "") => { failed++; console.error(`  ✗ ${n}${d ? ` — ${d}` : ""}`); };

async function main() {
  const admin = supabaseAdminClient();
  const created: { listings: string[]; deals: string[]; users: string[] } = { listings: [], deals: [], users: [] };

  const cleanup = async () => {
    if (created.deals.length) await admin.from("wl_deals").delete().in("id", created.deals);
    if (created.listings.length) await admin.from("wl_listings").delete().in("id", created.listings);
    if (created.users.length) await admin.from("users").delete().in("id", created.users);
  };

  try {
    // ---- two throwaway users ----
    const mk = async (tag: string) => {
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      const { data, error } = await admin.from("users").insert({
        uid: `smoke-${tag}-${stamp}`,
        email: `smoke-${tag}-${stamp}@slimemarket.app`,
        name: `smoke-${tag}`,
        role: "Member",
        referral_code: `SMOKE${stamp.slice(-8).toUpperCase()}`,
      }).select("id").single();
      if (error || !data) throw new Error(`create user ${tag}: ${error?.message}`);
      created.users.push(data.id);
      return data.id as string;
    };
    const alice = await mk("alice"); // listing creator
    const bob = await mk("bob");     // responder

    // =====================================================================
    console.log("\n--- A1: WTB listing flips the roles ---");
    // =====================================================================

    const mkListing = async (side: "WTS" | "WTB", owner: string) => {
      const { data, error } = await admin.from("wl_listings").insert({
        seller_id: owner, project: "SmokeProject", wl_type: "GTD", type: "mint",
        side, unit_price: "1000000", qty: 1, collateral: false,
      }).select("id").single();
      if (error || !data) throw new Error(`create listing: ${error?.message}`);
      created.listings.push(data.id);
      return data.id as string;
    };

    // WTS: alice sells, bob responds → alice = seller, bob = buyer.
    const wts = await mkListing("WTS", alice);
    const { data: wtsDeal, error: wtsErr } = await admin.rpc("create_wl_deal", {
      p_buyer_id: bob, p_listing_id: wts, p_unit: 1_000_000, p_qty: 1,
      p_is_offer: false, p_base_fee: 20_000,
    });
    if (wtsErr) bad("WTS deal created", wtsErr.message);
    else {
      created.deals.push(wtsDeal as string);
      const { data: d } = await admin.from("wl_deals")
        .select("buyer_id, seller_id").eq("id", wtsDeal as string).single();
      if (d?.buyer_id === bob && d?.seller_id === alice) ok("WTS: responder buys, owner sells");
      else bad("WTS: responder buys, owner sells", `buyer=${d?.buyer_id} seller=${d?.seller_id}`);
    }

    // WTB: alice wants to BUY, bob responds → alice = buyer, bob = seller.
    const wtb = await mkListing("WTB", alice);
    const { data: wtbDeal, error: wtbErr } = await admin.rpc("create_wl_deal", {
      p_buyer_id: bob, p_listing_id: wtb, p_unit: 1_000_000, p_qty: 1,
      p_is_offer: false, p_base_fee: 20_000,
    });
    if (wtbErr) bad("WTB deal created", wtbErr.message);
    else {
      created.deals.push(wtbDeal as string);
      const { data: d } = await admin.from("wl_deals")
        .select("buyer_id, seller_id").eq("id", wtbDeal as string).single();
      // THE critical assertion: on WTB the listing OWNER is the buyer.
      if (d?.buyer_id === alice && d?.seller_id === bob) ok("WTB: owner BUYS, responder SELLS");
      else bad("WTB: owner BUYS, responder SELLS", `buyer=${d?.buyer_id} seller=${d?.seller_id}`);
    }

    // Responding to your own listing must still be rejected on both sides.
    const { error: selfErr } = await admin.rpc("create_wl_deal", {
      p_buyer_id: alice, p_listing_id: wtb, p_unit: 1_000_000, p_qty: 1,
      p_is_offer: false, p_base_fee: 20_000,
    });
    if (selfErr && /own listing/i.test(selfErr.message)) ok("self-trade rejected on WTB", selfErr.message);
    else bad("self-trade rejected on WTB", selfErr?.message ?? "no error raised");

    // =====================================================================
    console.log("\n--- D3: proof of payment ---");
    // =====================================================================

    // Move a deal to ESCROW with a fiat leg.
    const dealId = wtbDeal as string;
    await admin.from("wl_deals")
      .update({ status: "ESCROW", fiat_leg: true, needs_collateral: false })
      .eq("id", dealId);

    // Seller cannot confirm before the buyer declares — the two stamps must pair.
    const { error: earlyErr } = await admin.rpc("confirm_wl_deal_payment", {
      p_deal_id: dealId, p_actor_id: bob,
    });
    if (earlyErr && /not marked/i.test(earlyErr.message)) ok("seller cannot confirm before the buyer declares");
    else bad("seller cannot confirm before the buyer declares", earlyErr?.message ?? "no error raised");

    // Only the buyer may declare.
    const { error: wrongActor } = await admin.rpc("mark_wl_deal_paid", {
      p_deal_id: dealId, p_actor_id: bob,
    });
    if (wrongActor && /buyer only/i.test(wrongActor.message)) ok("only the buyer may declare payment");
    else bad("only the buyer may declare payment", wrongActor?.message ?? "no error raised");

    // Buyer declares.
    const { error: markErr } = await admin.rpc("mark_wl_deal_paid", {
      p_deal_id: dealId, p_actor_id: alice,
    });
    if (markErr) bad("buyer declares payment", markErr.message);
    else {
      const { data: d } = await admin.from("wl_deals")
        .select("payment_marked_at").eq("id", dealId).single();
      if (d?.payment_marked_at) ok("buyer declaration stamped");
      else bad("buyer declaration stamped");
    }

    // Seller cannot mark delivered until they confirm the money arrived.
    const { error: delErr } = await admin.rpc("mark_wl_deal_delivered", {
      p_deal_id: dealId, p_actor_id: bob,
    });
    if (delErr && /confirm the fiat payment/i.test(delErr.message)) ok("delivery BLOCKED until payment confirmed");
    else bad("delivery BLOCKED until payment confirmed", delErr?.message ?? "no error raised");

    // Seller confirms.
    const { error: confErr } = await admin.rpc("confirm_wl_deal_payment", {
      p_deal_id: dealId, p_actor_id: bob,
    });
    if (confErr) bad("seller confirms payment", confErr.message);
    else {
      const { data: d } = await admin.from("wl_deals")
        .select("payment_confirmed_at").eq("id", dealId).single();
      if (d?.payment_confirmed_at) ok("seller confirmation stamped");
      else bad("seller confirmation stamped");
    }

    // Now delivery is allowed.
    const { error: del2Err } = await admin.rpc("mark_wl_deal_delivered", {
      p_deal_id: dealId, p_actor_id: bob,
    });
    if (del2Err) bad("delivery allowed after confirmation", del2Err.message);
    else ok("delivery allowed after confirmation");

    // Idempotency: re-declaring must not error and must not move the stamp.
    const { data: before } = await admin.from("wl_deals")
      .select("payment_marked_at").eq("id", dealId).single();
    await admin.rpc("mark_wl_deal_paid", { p_deal_id: dealId, p_actor_id: alice });
    const { data: after } = await admin.from("wl_deals")
      .select("payment_marked_at").eq("id", dealId).single();
    if (before?.payment_marked_at === after?.payment_marked_at) ok("re-declaring is a no-op (stamp unchanged)");
    else bad("re-declaring is a no-op (stamp unchanged)", "timestamp moved");

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
    else console.log("✅ A1 (WTB) and D3 (proof of payment) both behave correctly.");
  } finally {
    await cleanup();
    console.log("  (smoke data cleaned up)");
  }
}

main().catch((e) => {
  console.error("\nsmoke failed:", e.message || e);
  process.exit(1);
});
