/**
 * .C1 — virtual store identity.
 *
 * There is no longer a separate "store" concept: a Seller's identity IS
 * their store. The `stores` table stays (11 money RPCs join it), but every
 * row is AUTO-DERIVED from the owning `users` row:
 *
 *   store name   = users.username (fallback users.name)
 *   store handle = '@' + username
 *   store uid    = users.uid (the 4-char UID — store uid == user uid)
 *   owner_user_id = users.id
 *
 * The `ensure_store_for_user` RPC (migration 0003) is reused — it is
 * idempotent (`on conflict (owner_user_id) do nothing`) and already accepts
 * exactly the params we need; only the VALUES changed from application-driven
 * to user-derived.
 */
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export interface VirtualStoreIdentity {
  /** Display name of the store (username, falling back to users.name). */
  name: string;
  /** Store handle, e.g. '@frost'. */
  handle: string;
  /** Store uid — equals the user's 4-char uid. */
  uid: string;
}

export type VirtualStoreIdentityInput = {
  uid: string;
  username?: string | null;
  name?: string | null;
  handle?: string | null;
};

/**
 * Derive the virtual-store identity from a users row (or CurrentUser-like
 * object). Defensive: username may be null for very old rows, in which case
 * we fall back to the display name.
 */
export function deriveStoreIdentity(row: VirtualStoreIdentityInput): VirtualStoreIdentity {
  // Legacy seed rows store username WITH a leading '@' — normalize it away.
  const username =
    (row.username || "").replace(/^@/, "") ||
    (row.handle ? String(row.handle).replace(/^@/, "") : "") ||
    row.name ||
    "seller";
  return {
    name: username,
    handle: "@" + username,
    uid: row.uid,
  };
}

/**
 * Ensure a store row exists for the given user, derived from their identity.
 * Idempotent — safe to call on every approval and on every product create
 * (self-healing path for sellers approved before .C1).
 *
 * Returns the store row id.
 */
export async function provisionVirtualStore(userId: string): Promise<string> {
  const admin = supabaseAdminClient();
  const { data: u, error: uErr } = await admin
    .from("users")
    .select("uid, username, name, handle, avatar_url, avatar_gradient")
    .eq("id", userId)
    .maybeSingle();
  if (uErr) throw new Error(`provisionVirtualStore: user lookup failed: ${uErr.message}`);
  if (!u) throw new Error("provisionVirtualStore: user not found");

  const identity = deriveStoreIdentity(u as VirtualStoreIdentityInput);
  const { data: storeId, error } = await admin.rpc("ensure_store_for_user", {
    p_user_id: userId,
    p_name: identity.name,
    p_handle: identity.handle,
    p_uid: identity.uid,
  });
  if (error) throw new Error(`provisionVirtualStore: ensure_store_for_user failed: ${error.message}`);
  if (!storeId) throw new Error("provisionVirtualStore: ensure_store_for_user returned no store id");

  // Sync avatar from the profile (the store avatar IS the user avatar).
  // Never overwrites a store row that already has an image? No — the profile
  // is the source of truth, so always mirror it. Errors here are non-fatal.
  try {
    await admin
      .from("stores")
      .update({
        avatar_url: (u.avatar_url as string | null) ?? null,
        avatar_gradient: (u.avatar_gradient as string | null) ?? "from-arc-primary to-arc-accent",
        updated_at: new Date().toISOString(),
      })
      .eq("owner_user_id", userId);
  } catch {
    // Non-fatal: avatar mirror failure must not block store provisioning.
  }

  return storeId as string;
}
