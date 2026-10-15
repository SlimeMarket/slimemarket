import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { mapStore, mapReview, type StoreApiRow, type ReviewApiRow } from "./mappers";
import { deriveStoreIdentity } from "./virtual-store";

/**
 * Store + review queries. Maps DB columns to the frontend field names
 * (avatar_gradient → avatar, banner_gradient → banner, etc.).
 */

/** Sanitize an identifier for use inside a PostgREST `.or(...)` filter.
 * PostgREST splits `.or()` arguments on commas, so a raw user-supplied
 * identifier containing a comma would inject extra clauses. We only use
 * these in `.eq.` comparisons, so stripping the separator chars is safe. */
function safeOrIdentifier(s: string): string {
  return s.replace(/[(),]/g, "");
}

/**
 * Get a store by its public uid, name, or handle. Public.
 * The SPA navigates stores by display name (window.STORES is keyed by name),
 * so this must resolve all three identifiers — mirroring getStoreReviews'
 * resolveStoreId. Image URL columns take priority over gradient fallbacks.
 *
 * .C1 — virtual store: if no `stores` row matches, fall back to the
 * USER identity. A Seller's store IS their profile (name = username, uid =
 * user uid). This keeps store pages working even when the stores row is
 * missing / not yet backfilled.
 */
export async function getStoreByUid(uid: string): Promise<StoreApiRow | null> {
  const admin = supabaseAdminClient();
  const id = safeOrIdentifier(uid);
  const { data, error } = await admin
    .from("stores")
    .select(
      "name, handle, uid, avatar_gradient, banner_gradient, avatar_url, banner_url, rating, rating_count, joined_at, message",
    )
    .or(`uid.eq.${id},name.eq.${id},handle.eq.${id}`)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getStoreByUid failed: ${error.message}`);
  if (data) return mapStore(data);

  // No stores row — derive a STORE-shaped object from the users table.
  return resolveVirtualStoreFromUser(admin, uid);
}

/**
 * .C1 — resolve a store-shaped object from the `users` table when there
 * is no `stores` row. Matches the user's username, uid, or handle. Only
 * Seller/Admin roles expose a store. Defensive: returns null on any miss.
 *
 * Rating: `users` has no rating column, so derived stores report rating=0 /
 * ratingCount=0. Rated sellers rely on their `stores` row existing (backfilled
 * by approveApplication / createProduct self-heal); this is the documented
 * limitation of the derived path.
 */
async function resolveVirtualStoreFromUser(
  admin: ReturnType<typeof supabaseAdminClient>,
  identifier: string,
): Promise<StoreApiRow | null> {
  const id = safeOrIdentifier(identifier);
  // users.username is stored either as 'foo' or '@foo' (legacy seed) — match
  // both spellings. handle is always '@foo'.
  const bare = id.replace(/^@/, "");
  const at = "@" + bare;
  const { data: user } = await admin
    .from("users")
    .select("uid, username, name, handle, role, avatar_url, avatar_gradient, banner_gradient, joined_at")
    .or(`username.eq.${bare},username.eq.${at},uid.eq.${bare},handle.eq.${at}`)
    .limit(1)
    .maybeSingle();

  if (!user) return null;
  if (user.role !== "Seller" && user.role !== "Admin") return null;

  const identity = deriveStoreIdentity(user as {
    uid: string; username?: string | null; name?: string | null; handle?: string | null;
  });

  const joined = user.joined_at
    ? new Date(user.joined_at).toLocaleDateString("en-US", {
        day: "2-digit", month: "short", year: "numeric",
      })
    : "";

  return {
    name: identity.name,
    handle: identity.handle,
    uid: identity.uid,
    avatar: (user.avatar_url as string | null) || (user.avatar_gradient as string | null) || null,
    banner: (user.banner_gradient as string | null) || null,
    rating: 0,
    ratingCount: 0,
    online: true,
    joined,
    message: null,
  };
}

/**
 * Resolve a store id from a uid OR name OR handle.
 * The frontend navigates stores by display name (the STORES map is keyed by
 * name), but the API accepts the public uid. Accept all three so callers can
 * pass whichever identifier they hold.
 */
async function resolveStoreId(identifier: string): Promise<string | null> {
  const admin = supabaseAdminClient();
  // .F-fix — same PostgREST `.or(...)` injection guard its sibling
  // getStoreByUid uses (user input feeds an .or filter clause directly).
  const id = safeOrIdentifier(identifier);
  const { data } = await admin
    .from("stores")
    .select("id, uid, name, handle")
    .or(`uid.eq.${id},name.eq.${id},handle.eq.${id}`)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Get reviews for a store (by store uid, name, or handle). Verified-purchase
 * only (reviews.order_id exists). Public.
 */
export async function getStoreReviews(storeUid: string): Promise<ReviewApiRow[]> {
  const admin = supabaseAdminClient();

  // Resolve store id (accepts uid, name, or handle).
  const storeId = await resolveStoreId(storeUid);
  if (!storeId) return [];

  // Join reviews → orders → users(buyer) for the avatar gradient.
  const { data, error } = await admin
    .from("reviews")
    .select(`
      display_name, rating, text, created_at,
      orders!inner ( buyer_id ),
      users:orders!buyer_id ( avatar_gradient )
    `)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    // Fallback: simpler query without the buyer join if the nested join shape differs.
    const { data: simple, error: e2 } = await admin
      .from("reviews")
      .select("display_name, rating, text, created_at")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (e2 || !simple) return [];
    return simple.map((r) =>
      mapReview({
        display_name: r.display_name,
        rating: r.rating,
        text: r.text,
        created_at: r.created_at,
        buyer_avatar: null,
      })
    );
  }

  return (data ?? []).map((r) => {
    const row = r as unknown as {
      display_name: string | null;
      rating: number;
      text: string | null;
      created_at: string;
      users?: { avatar_gradient?: string | null } | { avatar_gradient?: string | null }[];
    };
    const buyerAvatar = Array.isArray(row.users)
      ? row.users[0]?.avatar_gradient ?? null
      : row.users?.avatar_gradient ?? null;
    return mapReview({
      display_name: row.display_name,
      rating: row.rating,
      text: row.text,
      created_at: row.created_at,
      buyer_avatar: buyerAvatar,
    });
  });
}

/** Rating summary shown above the review list on a product page. */
export interface ReviewSummary {
  avg: number;
  count: number;
  /** Number of reviews per star, index 0 = 1★ … index 4 = 5★. */
  dist: [number, number, number, number, number];
}

export interface ProductReviewsResult {
  items: ReviewApiRow[];
  summary: ReviewSummary;
}

/**
 * Verified-purchase reviews for a single PRODUCT (public).
 *
 * `reviews` has no product column — a review belongs to an ORDER, and the
 * order knows the product. We therefore resolve the product's orders first and
 * filter reviews by `order_id`. Deliberately two queries instead of one nested
 * PostgREST join on `orders.product_id`: the embedded filter is easy to get
 * subtly wrong (and silently returns nothing when it is), while two plain
 * queries are trivially verifiable.
 */
export async function getProductReviews(productId: string): Promise<ProductReviewsResult> {
  const empty: ProductReviewsResult = {
    items: [],
    summary: { avg: 0, count: 0, dist: [0, 0, 0, 0, 0] },
  };
  if (!productId) return empty;

  const admin = supabaseAdminClient();

  const { data: orders, error: oErr } = await admin
    .from("orders")
    .select("id, buyer_id")
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (oErr || !orders || orders.length === 0) return empty;

  const orderIds = orders.map((o) => o.id as string);
  const buyerByOrder = new Map<string, string>(
    orders.map((o) => [o.id as string, (o.buyer_id as string) ?? ""]),
  );

  const { data: rows, error: rErr } = await admin
    .from("reviews")
    .select("order_id, display_name, rating, text, created_at")
    .in("order_id", orderIds)
    .order("created_at", { ascending: false })
    .limit(50);
  if (rErr || !rows || rows.length === 0) return empty;

  // Buyer avatars (best-effort — a missing avatar falls back to a gradient).
  const buyerIds = [...new Set([...buyerByOrder.values()].filter(Boolean))];
  const avatarByUser = new Map<string, string>();
  if (buyerIds.length > 0) {
    const { data: users } = await admin
      .from("users")
      .select("id, avatar_gradient")
      .in("id", buyerIds);
    for (const u of users ?? []) {
      if (u.avatar_gradient) avatarByUser.set(u.id as string, u.avatar_gradient as string);
    }
  }

  const items = rows.map((r) => {
    const buyerId = buyerByOrder.get(r.order_id as string) ?? "";
    return mapReview({
      display_name: r.display_name as string | null,
      rating: r.rating as number,
      text: r.text as string | null,
      created_at: r.created_at as string,
      buyer_avatar: avatarByUser.get(buyerId) ?? null,
    });
  });

  const dist: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const it of items) {
    const n = Math.min(5, Math.max(1, Math.round(it.rating)));
    dist[n - 1] += 1;
    sum += n;
  }
  const count = items.length;
  const avg = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;

  return { items, summary: { avg, count, dist } };
}
