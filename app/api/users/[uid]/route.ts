/**
 * GET /api/users/[uid]
 * 
 * Public user profile lookup by UID (4-char code).
 * Returns: name, uid, handle, avatar, role, joinedAt, rating, store info.
 * No sensitive data (no email, no wallet address, no circle_user_id).
 */
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ uid: string }> }
) {
  const { uid } = await params;

  if (!uid || uid.length < 3 || uid.length > 5) {
    return jsonError("Invalid UID", 400);
  }

  const admin = supabaseAdminClient();

  // Get user by UID (public fields only)
  const { data: user, error } = await admin
    .from("users")
    .select(`
      id,
      uid,
      name,
      handle,
      role,
      avatar_url,
      avatar_gradient,
      banner_gradient,
      joined_at,
      tx_count,
      preferred_lang
    `)
    .eq("uid", uid.toUpperCase())
    .maybeSingle();

  if (error || !user) {
    return jsonError("User not found", 404);
  }

  // Check if user has a store (seller).
  // BUG FIX: this selected `category`, which does not exist on `stores` — so
  // PostgREST errored and `store` came back null for EVERY user, meaning a
  // seller's storefront never appeared on their own profile.
  const { data: store } = await admin
    .from("stores")
    .select("id, name, frozen, rating, rating_count")
    .eq("owner_user_id", user.id)
    .maybeSingle();

  // BUG FIX: this read `orders.rating`, which does not exist — ratings live in
  // `reviews`. The store row already carries a denormalised `rating` /
  // `rating_count`, so use those and drop the extra round-trip entirely.
  const avgRating = typeof store?.rating === "number" && store.rating > 0
    ? store.rating
    : null;
  const reviewCount = store?.rating_count ?? 0;

  // Count completed orders
  const { count: completedOrders } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("store_id", store?.id || "00000000-0000-0000-0000-000000000000")
    .in("status", ["DONE", "RELEASED"]);

  return jsonOk({
    uid: user.uid,
    name: user.name,
    handle: user.handle,
    role: user.role,
    avatarUrl: user.avatar_url,
    avatarGradient: user.avatar_gradient,
    bannerGradient: user.banner_gradient,
    joinedAt: user.joined_at,
    txCount: user.tx_count,
    preferredLang: user.preferred_lang,
    store: store ? {
      id: store.id,
      name: store.name,
      frozen: store.frozen,
    } : null,
    rating: avgRating ? Math.round(avgRating * 10) / 10 : null,
    reviewCount,
    completedOrders: completedOrders || 0,
  });
}
