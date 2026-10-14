import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { mapOrder, type OrderApiRow } from "./mappers";

const ORDER_SELECT = `
  id, created_at, status, product_id, variant, qty, amount, circle_fee, gas_fee,
  payment, delivery, credentials_vault_ref, terms, cancel_reason, decline_reason,
  sent_at, release_deadline, on_chain_order_id, on_chain_tx_hash, on_chain_status,
  on_chain_circle_tx_id, on_chain_error,
  payer_address, payer_wallet_type,
  buyer_id,
  products!inner ( name ),
  stores!inner ( name ),
  reviews ( rating, text )
`;

interface FlatRow {
  id: string; created_at: string; status: string;
  product_id: string; variant: string | null; qty: number;
  amount: string; circle_fee: string; gas_fee: string;
  payment: string; delivery: string;
  credentials_vault_ref: string | null; terms: string[] | null;
  cancel_reason: string | null; decline_reason: string | null;
  sent_at: string | null; release_deadline: string | null;
  on_chain_order_id: string | number | null;
  on_chain_tx_hash: string | null;
  on_chain_status: string | null;
  on_chain_circle_tx_id: string | null;
  on_chain_error: string | null;
  payer_address?: string | null;
  payer_wallet_type?: string | null;
  buyer_id?: string | null;
  buyer?: string | null;
  products: { name: string } | null;
  stores: { name: string } | null;
  reviews: { rating: number; text: string } | { rating: number; text: string }[] | null;
}

function flatten(r: FlatRow): Parameters<typeof mapOrder>[0] {
  const rev = Array.isArray(r.reviews) ? r.reviews[0] : r.reviews;
  return {
    id: r.id, created_at: r.created_at, status: r.status,
    product_id: r.product_id, product_name: r.products?.name ?? null,
    variant: r.variant, qty: r.qty, amount: r.amount,
    circle_fee: r.circle_fee, gas_fee: r.gas_fee, payment: r.payment, delivery: r.delivery,
    credentials_vault_ref: r.credentials_vault_ref, terms: r.terms,
    cancel_reason: r.cancel_reason, decline_reason: r.decline_reason,
    sent_at: r.sent_at, release_deadline: r.release_deadline,
    store_name: r.stores?.name ?? null,
    buyer: r.buyer ?? "Unknown",
    review_rating: rev?.rating ?? null, review_text: rev?.text ?? null,
    on_chain_order_id: r.on_chain_order_id ?? null,
    on_chain_tx_hash: r.on_chain_tx_hash ?? null,
    on_chain_status: r.on_chain_status ?? null,
    on_chain_circle_tx_id: r.on_chain_circle_tx_id ?? null,
    on_chain_error: r.on_chain_error ?? null,
    payer_address: r.payer_address ?? null,
    payer_wallet_type: r.payer_wallet_type ?? null,
  };
}

export async function listOrders(buyerId: string): Promise<OrderApiRow[]> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("buyer_id", buyerId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listOrders: ${error.message}`);
  return (data ?? []).map((r) => mapOrder(flatten(r as unknown as FlatRow)));
}

export async function listSellerOrders(userId: string): Promise<OrderApiRow[]> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("stores.owner_user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listSellerOrders: ${error.message}`);

  // After getting orders data, collect buyer_ids
  const rows = (data ?? []) as unknown as FlatRow[];
  const buyerIds = [...new Set(rows.map((r) => r.buyer_id).filter(Boolean))] as string[];
  if (buyerIds.length > 0) {
    const { data: buyers } = await admin.from("users").select("id, name, email").in("id", buyerIds);
    const buyerMap = new Map((buyers ?? []).map((b) => [b.id, b]));
    // Attach buyer name to each order row before mapping
    rows.forEach((r) => {
      const b = buyerMap.get(r.buyer_id ?? "");
      r.buyer = b?.name || b?.email || "Unknown";
    });
  }
  return rows.map((r) => mapOrder(flatten(r as unknown as FlatRow)));
}

export async function getOrder(id: string): Promise<OrderApiRow | null> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getOrder: ${error.message}`);
  if (!data) return null;
  return mapOrder(flatten(data as unknown as FlatRow));
}

export const getCreatedOrder = getOrder;
