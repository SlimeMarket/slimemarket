/**
 * WL escrow guards & mappers (A2/A4/A3).
 *
 * A2: `hasOnChainDeal` — any non-null/non-empty `wl_deals.on_chain_deal_id`
 *     means the on-chain deal is ALREADY created. "0" is a valid contract
 *     deal id (first deal ever created — live stuck deal b9dbcae6). Treating
 *     "0" as falsy caused duplicate create-relay attempts.
 * A4: `mapDeal` must surface the JOINED seller name/avatar instead of the
 *     hardcoded "Verified WL Seller" placeholder.
 * A3: `resolveDealSenderRole` stores the deal SIDE (buyer/seller) for escrow
 *     chat senders instead of the account role.
 */
import { describe, expect, it } from "vitest";
import { hasOnChainDeal } from "@/lib/wl/transitions";
import { mapDeal } from "@/lib/wl/mappers";
import { resolveDealSenderRole } from "@/lib/wl/chat";

const DEAL = "b9dbcae6-c5a7-47ae-8ffe-da6c26c78bef";
const BUYER = "1f189c86-ce0a-4afa-9e55-f03801e84eb6";
const SELLER = "8a3f2b2d-5739-41c1-91f5-0e4cc9f764a0";

describe("hasOnChainDeal (A2 idempotency)", () => {
  it('treats "0" as ALREADY CREATED (valid first contract deal id)', () => {
    expect(hasOnChainDeal("0")).toBe(true);
  });
  it("treats any non-empty id as already created", () => {
    expect(hasOnChainDeal("1")).toBe(true);
    expect(hasOnChainDeal("12345")).toBe(true);
  });
  it("treats null/undefined/empty as NOT created", () => {
    expect(hasOnChainDeal(null)).toBe(false);
    expect(hasOnChainDeal(undefined)).toBe(false);
    expect(hasOnChainDeal("")).toBe(false);
  });
});

describe("mapDeal (A4 participant names)", () => {
  const baseRow = {
    id: DEAL, status: "ESCROW", unit: "1000000", qty: 1,
    price: "1000000", base_fee: "4000000", total: "5000000",
    is_offer: false, needs_collateral: true, seller_collateral: "0",
    buyer_held: true, middleman_joined: true,
    buyer_id: BUYER, seller_id: SELLER,
    seller_name: "Rimuru" as string | null, seller_avatar: "from-emerald-500 to-cyan-600" as string | null,
    project: "gey" as string | null, created_at: "2026-08-09T07:53:06Z",
    on_chain_deal_id: "0" as string | null, on_chain_tx_hash: null, on_chain_status: "CREATED" as string | null,
    buyer_payer_address: null, buyer_payer_wallet_type: null,
    seller_collateral_tx_hash: null, seller_collateral_wallet_type: null,
  };

  it("surfaces the JOINED seller name + avatar", () => {
    const m = mapDeal(baseRow);
    expect(m.seller).toBe("Rimuru");
    expect(m.sellerAvatar).toBe("from-emerald-500 to-cyan-600");
  });

  it('falls back to "Unknown" + default gradient when join is missing', () => {
    const m = mapDeal({ ...baseRow, seller_name: null, seller_avatar: null });
    expect(m.seller).toBe("Unknown");
    expect(m.sellerAvatar).toBe("from-slate-600 to-slate-800");
  });

  it("keeps money fields + on-chain id passthrough", () => {
    const m = mapDeal(baseRow);
    expect(m.price).toBe(1);
    expect(m.total).toBe(5);
    expect(m.onChainDealId).toBe("0"); // "0" stays a real id end-to-end
  });
});

describe("resolveDealSenderRole (A3 chat identity)", () => {
  it("Seller-account acting as BUYER is stored as buyer", () => {
    expect(resolveDealSenderRole({
      senderId: BUYER, buyerId: BUYER, sellerId: SELLER, accountRole: "Seller",
    })).toBe("buyer");
  });

  it("Buyer-account acting as SELLER is stored as seller", () => {
    expect(resolveDealSenderRole({
      senderId: SELLER, buyerId: BUYER, sellerId: SELLER, accountRole: "Buyer",
    })).toBe("seller");
  });

  it("admins keep their account role (lowercased)", () => {
    expect(resolveDealSenderRole({
      senderId: "some-admin", buyerId: BUYER, sellerId: SELLER, accountRole: "Admin",
    })).toBe("admin");
  });

  it("middlemen keep the middleman role", () => {
    expect(resolveDealSenderRole({
      senderId: "mm-1", buyerId: BUYER, sellerId: SELLER, accountRole: "Middleman",
    })).toBe("middleman");
  });

  it("MM account role maps to middleman (was 'mm' → CHECK violation)", () => {
    expect(resolveDealSenderRole({
      senderId: "mm-1", buyerId: BUYER, sellerId: SELLER, accountRole: "MM",
    })).toBe("middleman");
  });

  it("Member (default signup role) maps to a valid sender_role, not 'member'", () => {
    // Previously clamped to "admin", which mislabelled an ordinary user as
    // staff in the deal room. "buyer" is the honest non-party default.
    const out = resolveDealSenderRole({
      senderId: "x", buyerId: BUYER, sellerId: SELLER, accountRole: "Member",
    });
    expect(out).toBe("buyer");
    expect(["buyer", "seller", "middleman", "system", "admin"]).toContain(out);
  });

  it("unknown account roles clamp to a value valid for the sender_role CHECK", () => {
    for (const junk of ["", "superuser", "root", "Unknown"]) {
      expect(["buyer", "seller", "middleman", "system", "admin"]).toContain(
        resolveDealSenderRole({
          senderId: "x", buyerId: BUYER, sellerId: SELLER, accountRole: junk,
        })
      );
    }
  });
});
