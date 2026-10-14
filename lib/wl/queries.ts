import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { mapListing, mapDeal, type ListingApiRow, type DealApiRow } from "./mappers";
import type { DisputeBrief, DisputeEvidenceItem } from "@/lib/disputes/brief";

const LISTING_SELECT = `
  id, project, wl_type, type, side, unit_price, mint_price, qty, project_link,
  offer, collateral, "desc", gradient, glyph, img_url, delivery_window_seconds,
  users!inner ( name, avatar_gradient )
`;

const DEAL_SELECT = `
  id, status, unit, qty, price, base_fee, total, is_offer, needs_collateral,
  seller_collateral, buyer_held, middleman_joined, buyer_id, seller_id, created_at,
  on_chain_deal_id, on_chain_tx_hash, on_chain_status,
  buyer_payer_address, buyer_payer_wallet_type,
  seller_collateral_tx_hash, seller_collateral_wallet_type,
  delivery_deadline, confirm_deadline, delivered_at, disputed_at, collateral_slashed,
  dispute_reason, dispute_evidence, dispute_brief, dispute_brief_at,
  fiat_leg, payment_marked_at, payment_confirmed_at,
  wl_listings ( project, img_url ),
  seller:users!wl_deals_seller_id_fkey ( name, avatar_gradient )
`;

function flatListing(r: Record<string, unknown>): Parameters<typeof mapListing>[0] {
  const u = (r.users as Record<string, unknown>) ?? {};
  return {
    id: r.id as string, project: r.project as string, wl_type: r.wl_type as string | null,
    type: r.type as string, side: r.side as string | null,
    unit_price: r.unit_price as string | number,
    mint_price: r.mint_price as string | number, qty: r.qty as number,
    project_link: r.project_link as string | null, offer: r.offer as boolean,
    collateral: r.collateral as boolean, desc: r.desc as string | null,
    gradient: r.gradient as string | null, glyph: r.glyph as string | null,
    img_url: (r.img_url as string | null) ?? null,
    seller_name: u.name as string | null, seller_avatar: u.avatar_gradient as string | null,
  };
}

function flatDeal(r: Record<string, unknown>): Parameters<typeof mapDeal>[0] {
  const s = (r.seller as Record<string, unknown>) ?? {};
  const wl = (r.wl_listings as Record<string, unknown> | null) ?? {};
  return {
    id: r.id as string, status: r.status as string,
    unit: r.unit as string | number, qty: r.qty as number,
    price: r.price as string | number, base_fee: r.base_fee as string | number,
    total: r.total as string | number, is_offer: r.is_offer as boolean,
    needs_collateral: r.needs_collateral as boolean,
    seller_collateral: r.seller_collateral as string | number,
    buyer_held: r.buyer_held as boolean, middleman_joined: r.middleman_joined as boolean,
    buyer_id: r.buyer_id as string, seller_id: r.seller_id as string,
    seller_name: s.name as string | null, seller_avatar: s.avatar_gradient as string | null,
    project: (wl.project as string | null) ?? null,
    listing_img: (wl.img_url as string | null) ?? null,
    created_at: r.created_at as string,
    on_chain_deal_id: (r.on_chain_deal_id as string | null) ?? null,
    on_chain_tx_hash: (r.on_chain_tx_hash as string | null) ?? null,
    on_chain_status: (r.on_chain_status as string | null) ?? null,
    buyer_payer_address: (r.buyer_payer_address as string | null) ?? null,
    buyer_payer_wallet_type: (r.buyer_payer_wallet_type as string | null) ?? null,
    seller_collateral_tx_hash: (r.seller_collateral_tx_hash as string | null) ?? null,
    seller_collateral_wallet_type: (r.seller_collateral_wallet_type as string | null) ?? null,
    // D3 — the off-platform payment trail.
    fiat_leg: r.fiat_leg as boolean | undefined,
    payment_marked_at: (r.payment_marked_at as string | null) ?? null,
    payment_confirmed_at: (r.payment_confirmed_at as string | null) ?? null,
    // BUG FIX: DEAL_SELECT fetches these five, but flatDeal never copied them, so
    // mapDeal received `undefined` and the API always returned null. Consequences:
    //   • deliveryDeadline/confirmDeadline null → `deliveryPassed`/`confirmPassed`
    //     in escrow.jsx were permanently false, so the "Force Refund" and
    //     "Force Release" escape hatches never rendered.
    //   • deliveredAt null → the seller's "Mark as Delivered" button stayed
    //     visible after delivering, and the "waiting for buyer" note never showed.
    //   • collateralSlashed dropped → the fraud outcome was invisible to the UI.
    delivery_deadline: (r.delivery_deadline as string | null) ?? null,
    confirm_deadline: (r.confirm_deadline as string | null) ?? null,
    delivered_at: (r.delivered_at as string | null) ?? null,
    disputed_at: (r.disputed_at as string | null) ?? null,
    // Dispute case file. These MUST be copied here or the API returns null for
    // them — the exact bug (#34) that hid delivery_deadline from the UI once.
    dispute_reason: (r.dispute_reason as string | null) ?? null,
    dispute_evidence: (r.dispute_evidence as DisputeEvidenceItem[] | null) ?? [],
    dispute_brief: (r.dispute_brief as DisputeBrief | null) ?? null,
    dispute_brief_at: (r.dispute_brief_at as string | null) ?? null,
    collateral_slashed: (r.collateral_slashed as string | number | null) ?? 0,
  };
}

export async function listListings(filter?: { side?: "WTS" | "WTB" }): Promise<ListingApiRow[]> {
  const admin = supabaseAdminClient();
  let q = admin.from("wl_listings").select(LISTING_SELECT);
  // A1 — the market can show both books (sell offers + buy requests).
  if (filter?.side) q = q.eq("side", filter.side);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw new Error(`listListings: ${error.message}`);
  return (data ?? []).map((r) => mapListing(flatListing(r as unknown as Record<string, unknown>)));
}

export async function getListing(id: string): Promise<ListingApiRow | null> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("wl_listings").select(LISTING_SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(`getListing: ${error.message}`);
  if (!data) return null;
  return mapListing(flatListing(data as unknown as Record<string, unknown>));
}

export async function createListing(user: { id: string }, input: {
  project: string; wlType?: string; type: string; side?: "WTS" | "WTB"; unitPrice: number;
  mintPrice?: number; qty: number; projectLink?: string; offer?: boolean;
  collateral: boolean; desc?: string; glyph?: string; gradient?: string;
  img?: string;
}): Promise<ListingApiRow> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("wl_listings")
    .insert({
      seller_id: user.id, project: input.project, wl_type: input.wlType ?? null,
      type: input.type,
      // A1 — direction. Defaults to WTS so existing callers are unaffected.
      side: input.side ?? "WTS",
      unit_price: (input.unitPrice * 1_000_000).toString(),
      mint_price: ((input.mintPrice ?? 0) * 1_000_000).toString(), qty: input.qty,
      project_link: input.projectLink ?? null, offer: input.offer ?? false,
      collateral: input.collateral, desc: input.desc ?? null,
      glyph: input.glyph ?? null, gradient: input.gradient ?? null,
      img_url: input.img ?? null,
    })
    .select(LISTING_SELECT)
    .single();
  if (error || !data) throw new Error(`createListing: ${error?.message}`);
  return mapListing(flatListing(data as unknown as Record<string, unknown>));
}

export async function listDealsForUser(userId: string): Promise<DealApiRow[]> {
  const admin = supabaseAdminClient();
  // buyer or seller sees their deals; admin sees all (filter client-side)
  const { data, error } = await admin
    .from("wl_deals")
    .select(DEAL_SELECT)
    .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listDeals: ${error.message}`);
  return (data ?? []).map((r) => mapDeal(flatDeal(r as unknown as Record<string, unknown>)));
}

export async function listAllDeals(): Promise<DealApiRow[]> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("wl_deals")
    .select(DEAL_SELECT)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listAllDeals: ${error.message}`);
  return (data ?? []).map((r) => mapDeal(flatDeal(r as unknown as Record<string, unknown>)));
}

export async function getDeal(id: string): Promise<DealApiRow | null> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("wl_deals")
    .select(DEAL_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getDeal: ${error.message}`);
  if (!data) return null;
  return mapDeal(flatDeal(data as unknown as Record<string, unknown>));
}
