import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { parseUsdc } from "@/lib/money";
import type { CurrentUser } from "@/lib/auth-ucw";
import { mapProduct, type ProductApiRow } from "./mappers";
import { uploadImageDataUrl, PRODUCT_IMAGE_BUCKET } from "@/lib/storage/upload";

/**
 * Catalog product queries. All money returned as decimal USDC via mapProduct.
 *
 * Products join stores + users to embed `seller: {name, rating, avatar}` so the
 * frontend's `product.seller.name` join (storeProducts helper) works without a
 * second round-trip.
 */

const PAGE_SIZE = 24;

/** Select + join shape used by list/get/store queries. */
const PRODUCT_SELECT = `
  id, name, category, delivery, price, variants, "desc",
  gradient, glyph, img_url, status, stock_items, stock, sold, views, hot, est,
  warranty,
  variant_stocks:product_stock_items(variant_label, status),
  stores!inner ( name, rating, avatar_gradient, avatar_url, owner_user_id, users:owner_user_id ( name, avatar_url, username, last_seen_at ) )
`;

/** Flatten the nested stores join into the mapProduct input shape. */
function flatten(row: Record<string, unknown>): Parameters<typeof mapProduct>[0] {
  const store = (row.stores as Record<string, unknown> | null) ?? {};
  // Aggregate product_stock_items rows into a {variantLabel: availableCount} map.
  const variantStockRows = (row.variant_stocks as Array<{ variant_label: string; status: string }> | null) ?? [];
  const variantStocks: Record<string, number> = {};
  for (const vsr of variantStockRows) {
    if (vsr.status === "available") {
      const label = vsr.variant_label || "Default";
      variantStocks[label] = (variantStocks[label] ?? 0) + 1;
    }
  }
  return {
    id: row.id as string,
    name: row.name as string,
    category: row.category as string | null,
    delivery: row.delivery as string,
    price: row.price as string | number,
    variants: row.variants as { label: string; price: number | string }[] | null,
    desc: row.desc as string,
    gradient: row.gradient as string | null,
    glyph: row.glyph as string | null,
    img_url: row.img_url as string | null,
    status: row.status as string,
    stock_items: row.stock_items as string[] | null,
    variant_stocks: variantStocks,
    stock: row.stock as number,
    sold: row.sold as number,
    views: row.views as number,
    hot: row.hot as boolean,
    est: row.est as number,
    store_name: (store.users as { name?: string | null } | null)?.name ?? (store.name as string | null),
    store_rating: store.rating as number | string | null,
    store_avatar: store.avatar_gradient as string | null,
    store_avatar_url: (store.users as { avatar_url?: string | null } | null)?.avatar_url ?? (store.avatar_url as string | null) ?? null,
    warranty: row.warranty as string | null,
    store_last_seen:
      (store.users as { last_seen_at?: string | null } | null)?.last_seen_at ?? null,
  };
}

export interface ListProductsResult {
  items: ProductApiRow[];
  total: number;
  page: number;
}

/** List products (public). Optional category filter + text search + pagination. */
export async function listProducts(args: {
  cat?: string | null;
  q?: string | null;
  page?: number;
}): Promise<ListProductsResult> {
  const { cat, q, page = 1 } = args;
  const admin = supabaseAdminClient();

  // Public visibility: active + soldout. (inactive is owner-only, not in M2 read.)
  let query = admin
    .from("products")
    .select(PRODUCT_SELECT, { count: "exact" })
    .in("status", ["active", "soldout"])
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  // "All" is the storefront's own sentinel (see CATEGORIES in public/data.jsx);
  // "Semua" is the Indonesian spelling older callers still send. Either one
  // means "no category filter" — treating it as a category name matches zero
  // rows, which is what made every topbar search return an empty catalog.
  const catNorm = (cat ?? "").trim();
  if (catNorm && !/^(all|semua)$/i.test(catNorm)) {
    query = query.eq("category", catNorm);
  }

  const term = (q ?? "").trim();
  if (term) {
    // Search the product name, but ALSO the store name and the seller's
    // username — buyers search "rimuru" as often as they search a title.
    // PostgREST cannot OR across a nested embed (stores.users.username), so the
    // matching sellers/stores are resolved first and then matched by id.
    const like = `%${term.replace(/[,()%\\]/g, " ")}%`;

    const { data: sellers } = await admin
      .from("users")
      .select("id")
      .or(`username.ilike.${like},name.ilike.${like}`)
      .limit(50);
    const sellerIds = (sellers ?? []).map((s) => s.id as string);

    let storeFilter = `name.ilike.${like}`;
    if (sellerIds.length) storeFilter += `,owner_user_id.in.(${sellerIds.join(",")})`;
    const { data: stores } = await admin
      .from("stores")
      .select("id")
      .or(storeFilter)
      .limit(100);
    const storeIds = (stores ?? []).map((s) => s.id as string);

    let productFilter = `name.ilike.${like}`;
    if (storeIds.length) productFilter += `,store_id.in.(${storeIds.join(",")})`;
    query = query.or(productFilter);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`listProducts failed: ${error.message}`);

  const items = (data ?? []).map((r) => mapProduct(flatten(r as unknown as Record<string, unknown>)));
  return { items, total: count ?? 0, page };
}

/** Single product by id (public). Returns null if not found or inactive-private. */
export async function getProduct(id: string): Promise<ProductApiRow | null> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getProduct failed: ${error.message}`);
  if (!data) return null;
  return mapProduct(flatten(data as unknown as Record<string, unknown>));
}

/** Products belonging to a store (by store uid). Public. */
export async function listStoreProducts(storeUid: string): Promise<ProductApiRow[]> {
  const admin = supabaseAdminClient();
  // Resolve store id by uid first.
  const { data: store, error: sErr } = await admin
    .from("stores")
    .select("id")
    .eq("uid", storeUid)
    .maybeSingle();
  if (sErr || !store) return [];

  const { data, error } = await admin
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("store_id", store.id)
    .in("status", ["active", "soldout"])
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listStoreProducts failed: ${error.message}`);
  return (data ?? []).map((r) => mapProduct(flatten(r as unknown as Record<string, unknown>)));
}

export interface CreateProductInput {
  name: string;
  category: string;
  delivery: "instant" | "manual";
  price: number; // decimal USDC (frontend input)
  glyph?: string;
  gradient?: string;
  img?: string; // base64 data URL (optional product image)
  desc: string;
  notes?: string;
  warranty?: string;
  stockItems?: string[]; // instant
  stock?: number; // manual
  variants?: { label: string; price: number; stockItems?: string[] }[];
}

/**
 * Create a product. Validates golden-rule constraints (API_CONTRACT §8 #10):
 * desc ≥ 10 chars, price > 0, stock ≥ 1.
 * Converts decimal price → micro-USDC for storage.
 */
export async function createProduct(
  user: CurrentUser,
  input: CreateProductInput
): Promise<ProductApiRow> {
  const name = input.name?.trim();
  const desc = input.desc?.trim();
  if (!name) throw new Error("name is required");
  if (!desc || desc.length < 10) throw new Error("desc must be at least 10 characters");
  if (!(input.price > 0)) throw new Error("price must be > 0");
  if (!["instant", "manual"].includes(input.delivery)) {
    throw new Error("delivery must be instant or manual");
  }
  if (input.delivery === "instant") {
    // Instant delivery requires stock. Either legacy flat `stockItems` OR
    // per-variant `stockItems` (when `variants` is provided). At least one
    // item total must exist.
    const hasFlatStock = !!input.stockItems && input.stockItems.length >= 1;
    const hasVariantStock = !!input.variants &&
      input.variants.some(v => !!v.stockItems && v.stockItems.filter(s => s.trim()).length >= 1);
    if (!hasFlatStock && !hasVariantStock) {
      throw new Error("instant delivery requires at least 1 stock item");
    }
  }
  if (input.delivery === "manual" && (input.stock ?? 0) < 1) {
    throw new Error("manual delivery requires stock >= 1");
  }

  const priceMicro = parseUsdc(input.price.toFixed(6));

  const admin = supabaseAdminClient();

  // Resolve the seller's store (created at seller-apply approval).
  // .C1 — SELF-HEALING: sellers approved before the virtual-store
  // rollout may lack a stores row; auto-provision it from their identity
  // instead of blocking the publish.
  let { data: store, error: sErr } = await admin
    .from("stores")
    .select("id, name, rating, avatar_gradient, joined_at")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (!sErr && !store) {
    const { provisionVirtualStore } = await import("@/lib/catalog/virtual-store");
    await provisionVirtualStore(user.id);
    const retry = await admin
      .from("stores")
      .select("id, name, rating, avatar_gradient, joined_at")
      .eq("owner_user_id", user.id)
      .maybeSingle();
    store = retry.data;
    sErr = retry.error;
  }
  if (sErr || !store) throw new Error("no store found for seller — apply as seller first");

  // Variants: when the seller provides a variants array, persist each as
  // {label, price(micro)}. Otherwise synthesize a single 'Default' variant at
  // the base price so reads always have a variant to render.
  const variantRows = (input.variants && input.variants.length > 0
    ? input.variants.map(v => ({ label: v.label, price: Math.round(v.price * 1_000_000) }))
    : [{ label: "Default", price: priceMicro }]);

  // For instant delivery with per-variant stock, the secrets live in
  // `product_stock_items` (one row per credential, keyed by variant_label).
  // The legacy flat `stock_items` text[] is only used when the seller did NOT
  // define per-variant stock (single-variant product).
  const hasVariantStock = input.delivery === "instant" && !!input.variants &&
    input.variants.some(v => !!v.stockItems && v.stockItems.filter(s => s.trim()).length >= 1);
  const flatStockItems = input.delivery === "instant" && !hasVariantStock
    ? (input.stockItems ?? [])
    : [];

  const insertRow = {
    store_id: store.id,
    name,
    category: input.category || "Digital Products",
    delivery: input.delivery,
    price: priceMicro.toString(),
    variants: variantRows,
    desc,
    notes: input.notes?.trim() || null,
    warranty: input.warranty?.trim() || null,
    gradient: input.gradient || null,
    glyph: input.glyph || null,
    status: "active",
    stock_items: flatStockItems,
    stock: input.delivery === "manual" ? input.stock ?? 0 : 0,
    sold: 0,
    views: 0,
    hot: false,
    est: 0,
  };

  const { data, error } = await admin
    .from("products")
    .insert(insertRow)
    .select(PRODUCT_SELECT)
    .single();
  if (error || !data) throw new Error(`createProduct failed: ${error?.message}`);

  const productId = (data as { id: string }).id;

  // Per-variant stock items: insert one row per credential into
  // `product_stock_items` (migration 0037). Only used when the seller provided
  // explicit per-variant stockItems at create time.
  if (input.delivery === "instant" && input.variants) {
    for (const v of input.variants) {
      if (v.stockItems && v.stockItems.length > 0) {
        const items = v.stockItems.filter(s => s.trim()).map(s => s.trim());
        if (items.length > 0) {
          const rows = items.map(secret => ({
            product_id: productId,
            variant_label: v.label.trim() || 'Default',
            secret,
            status: 'available',
          }));
          await admin.from('product_stock_items').insert(rows);
        }
      }
    }
  }

  // FIX: flat (single-variant) instant stock was written ONLY to the legacy
  // `products.stock_items` text[] array. `product_stock_items` — which the
  // seller center and storefront count for available stock — stayed empty, so
  // the two stores diverged the moment the seller restocked: the restock route
  // writes to BOTH, but the original items existed in only one. Result: the
  // product page said "3" while the seller center said "1". Mirror the flat
  // items into `product_stock_items` so both sources always agree.
  if (input.delivery === "instant" && !hasVariantStock && flatStockItems.length > 0) {
    const rows = flatStockItems
      .filter(s => typeof s === "string" && s.trim())
      .map(secret => ({
        product_id: productId,
        variant_label: "Default",
        secret: secret.trim(),
        status: "available",
      }));
    if (rows.length > 0) {
      await admin.from("product_stock_items").insert(rows);
    }
  }

  // Optional product image: upload to storage (fallback: inline data URL) then persist.
  if (input.img) {
    try {
      const url = await uploadImageDataUrl(PRODUCT_IMAGE_BUCKET, `p/${productId}`, input.img);
      await admin.from("products").update({ img_url: url }).eq("id", productId);
      (data as { img_url?: string | null }).img_url = url;
    } catch (e) {
      // Validation error (bad type/size) — non-fatal; product is created without an image.
      console.warn("product image rejected:", e instanceof Error ? e.message : String(e));
    }
  }

  const mapped = mapProduct(flatten(data as unknown as Record<string, unknown>));
  // mapProduct pulls store fields from the join; ensure joined_at is set.
  (mapped as ProductApiRow & { joined: string }).joined = store.joined_at
    ? new Date(store.joined_at as string).toLocaleDateString("en-US", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "";
  return mapped;
}

/** List products owned by the authenticated seller. */
export async function listMyProducts(user: CurrentUser): Promise<ProductApiRow[]> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("stores.owner_user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listMyProducts failed: ${error.message}`);
  return (data ?? []).map((r) => mapProduct(flatten(r as unknown as Record<string, unknown>)));
}
