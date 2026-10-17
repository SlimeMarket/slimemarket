/**
 * One query, three kinds of result: products, sellers/stores, and an order.
 *
 * The topbar promises "Search products, sellers, order ID…" — matching only
 * product titles made two thirds of that a lie. This module is the single
 * place that answers all three, so the storefront never has to guess.
 */
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { listProducts } from "./products";
import type { ProductApiRow } from "./mappers";

export interface SearchStoreRow {
  uid: string | null;
  handle: string | null;
  name: string;
  avatar: string | null;
  rating: number;
  ratingCount: number;
  productCount: number;
}

export interface SearchOrderRow {
  id: string;
  status: string;
  productName: string;
  amount: number;
  role: "buyer" | "seller";
}

export interface SearchResult {
  products: ProductApiRow[];
  stores: SearchStoreRow[];
  order: SearchOrderRow | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The UI prints short ids as `#3b7911ec` — accept that as an order search too. */
const SHORT_ID_RE = /^[0-9a-f]{8}$/;

function cleanTerm(q: string): string {
  // PostgREST `or()` splits on commas/parens — a stray one would break the
  // filter (or be interpreted as a new condition), so they never reach it.
  return q.trim().replace(/[,()%\\]/g, " ").replace(/\s+/g, " ");
}

async function findOrder(q: string, userId: string): Promise<SearchOrderRow | null> {
  const raw = q.trim().replace(/^#/, "").toLowerCase();
  const admin = supabaseAdminClient();

  let query = admin
    .from("orders")
    .select("id, status, amount, buyer_id, products(name), stores(owner_user_id)")
    .limit(1);

  if (UUID_RE.test(raw)) {
    query = query.eq("id", raw);
  } else if (SHORT_ID_RE.test(raw)) {
    // UUID columns compare lexicographically, so an 8-char prefix maps to a
    // range. `ilike` on a uuid column raises "operator does not exist".
    query = query
      .gte("id", `${raw}-0000-0000-0000-000000000000`)
      .lte("id", `${raw}-ffff-ffff-ffff-ffffffffffff`);
  } else {
    return null;
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;

  const row = data as unknown as {
    id: string;
    status: string;
    amount: string | number;
    buyer_id: string;
    products: { name?: string } | null;
    stores: { owner_user_id?: string } | null;
  };

  const isBuyer = row.buyer_id === userId;
  const isSeller = row.stores?.owner_user_id === userId;
  // Never reveal an order that is not yours — "not found" for everyone else.
  if (!isBuyer && !isSeller) return null;

  return {
    id: row.id,
    status: row.status,
    productName: row.products?.name || "Order",
    amount: Number(row.amount || 0) / 1_000_000,
    role: isBuyer ? "buyer" : "seller",
  };
}

export async function searchCatalog(args: {
  q: string;
  cat?: string | null;
  userId?: string | null;
}): Promise<SearchResult> {
  const term = args.q.trim();
  if (!term) return { products: [], stores: [], order: null };

  const admin = supabaseAdminClient();
  const like = `%${cleanTerm(term)}%`;

  // ── sellers: match the store name OR the owner's username / display name ──
  const { data: sellers } = await admin
    .from("users")
    .select("id")
    .or(`username.ilike.${like},name.ilike.${like}`)
    .limit(50);
  const sellerIds = (sellers ?? []).map((s) => (s as { id: string }).id);

  let storeFilter = `name.ilike.${like}`;
  if (sellerIds.length) storeFilter += `,owner_user_id.in.(${sellerIds.join(",")})`;

  const { data: storeRows } = await admin
    .from("stores")
    .select(
      "id, uid, handle, name, avatar_gradient, avatar_url, rating, rating_count",
    )
    .or(storeFilter)
    .limit(8);

  const storeIds = (storeRows ?? []).map((s) => (s as { id: string }).id);
  const productCounts: Record<string, number> = {};
  if (storeIds.length) {
    const { data: prods } = await admin
      .from("products")
      .select("store_id")
      .in("store_id", storeIds)
      .in("status", ["active", "soldout"]);
    for (const p of prods ?? []) {
      const sid = (p as { store_id: string }).store_id;
      productCounts[sid] = (productCounts[sid] ?? 0) + 1;
    }
  }

  const stores: SearchStoreRow[] = (storeRows ?? []).map((s) => {
    const r = s as unknown as {
      id: string;
      uid: string | null;
      handle: string | null;
      name: string;
      avatar_gradient: string | null;
      avatar_url: string | null;
      rating: number | string;
      rating_count: number;
    };
    return {
      uid: r.uid,
      handle: r.handle,
      name: r.name,
      avatar: r.avatar_url || r.avatar_gradient,
      rating: Number(r.rating ?? 0),
      ratingCount: Number(r.rating_count ?? 0),
      productCount: productCounts[r.id] ?? 0,
    };
  });

  // ── products: same query the catalog uses, so results cannot diverge ─────
  const productResult = await listProducts({ q: term, cat: args.cat ?? null, page: 1 });

  // ── order: only for the signed-in buyer or seller of that order ──────────
  const order = args.userId ? await findOrder(term, args.userId) : null;

  return { products: productResult.items, stores, order };
}
