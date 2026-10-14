import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { deriveStoreIdentity } from "@/lib/catalog/virtual-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/my/store
 *
 * .C1 — virtual store: a Seller's store IS their profile. This returns
 * the user-derived store identity (name = username, handle = '@'+username,
 * uid = user uid). When a `stores` row exists its rating/counts are carried
 * through; otherwise the derived defaults (rating 0) are returned.
 *
 * The Store Editor UI was removed — PATCH now returns 410 Gone.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const admin = supabaseAdminClient();
  const identity = deriveStoreIdentity({
    uid: user.uid,
    username: user.username,
    name: user.name,
    handle: user.handle,
  });

  const { data: storeRow } = await admin
    .from("stores")
    .select("avatar_url, avatar_gradient, banner_url, banner_gradient, message, rating, rating_count, joined_at")
    .eq("owner_user_id", user.id)
    .maybeSingle();

  return jsonOk({
    store: {
      name: identity.name,
      handle: identity.handle,
      uid: identity.uid,
      avatar_url: storeRow?.avatar_url ?? user.avatarUrl,
      avatar_gradient: storeRow?.avatar_gradient ?? user.avatarGradient,
      banner_url: storeRow?.banner_url ?? null,
      banner_gradient: storeRow?.banner_gradient ?? user.bannerGradient,
      message: storeRow?.message ?? null,
      rating: storeRow?.rating ?? 0,
      rating_count: storeRow?.rating_count ?? 0,
      joined_at: storeRow?.joined_at ?? user.joinedAt,
      // .C1 marker — the FE may key off this to render the
      // "your profile is your storefront" hint.
      profileStorefront: true,
    },
  });
}

/**
 * PATCH /api/my/store — REMOVED (.C1).
 * There is no separate store to edit: your profile IS your storefront.
 * Kept as a handler so stale frontend calls get a clear, actionable error
 * instead of a 405/404 surprise.
 */
export async function PATCH() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  return jsonError(
    "Store editing removed — your profile is your storefront. Edit your profile instead.",
    410
  );
}
