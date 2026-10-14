import { getCurrentUser } from "@/lib/auth-ucw";
import { formatUsdc } from "@/lib/money";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { sanitizeText } from "@/lib/sanitize";
import { PREFERRED_LANGS, isPreferredLang } from "@/lib/types";

/**
 * GET /api/me
 * Returns the authenticated user's profile + wallet + role + txCount.
 * Mirrors the ME object in data.jsx.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  // Fetch wallet. Use admin client when available; otherwise fall back to
  // a zero-balance placeholder so the route still responds in dev.
  let wallet: { address: string | null; usdc_balance: string | number; forum_balance: string | number } | null = null;
  try {
    const { supabaseAdminClient } = await import("@/lib/supabase/admin-client");
    const admin = supabaseAdminClient();
    const r = await admin
      .from("wallets")
      .select("address, usdc_balance, forum_balance")
      .eq("user_id", user.id)
      .maybeSingle();
    wallet = r.data;
  } catch {
    // Supabase not configured (dev) — leave wallet null.
  }

  return jsonOk({
    user: {
      id: user.id,
      uid: user.uid,
      name: user.name,
      username: user.username,
      handle: user.handle,
      email: user.email,
      role: user.role,
      txCount: user.txCount,
      avatarImg: user.avatarUrl,
      avatar: user.avatarGradient,
      banner: user.bannerGradient,
    },
    wallet: {
      address: wallet?.address ?? null,
      usdc: wallet ? formatUsdc(BigInt(wallet.usdc_balance as bigint | string | number)) : "0",
      usdcMicro: wallet?.usdc_balance ?? 0,
      forumBalance: wallet ? formatUsdc(BigInt(wallet.forum_balance as bigint | string | number)) : "0",
    },
  });
}

/**
 * PATCH /api/me
 * Update the authenticated user's profile (contacts, etc).
 */
export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const body = await req.json();
  const { supabaseAdminClient } = await import("@/lib/supabase/admin-client");
  const admin = supabaseAdminClient();

  const patch: Record<string, unknown> = {};
  if (body.contacts !== undefined) {
    // Sanitize contact strings (Discord, Telegram, X handles)
    const c = body.contacts as Record<string, unknown>;
    patch.contacts = {
      ...(c.discord !== undefined && { discord: sanitizeText(c.discord) }),
      ...(c.telegram !== undefined && { telegram: sanitizeText(c.telegram) }),
      ...(c.x !== undefined && { x: sanitizeText(c.x) }),
    };
  }
  if (body.name !== undefined) patch.name = sanitizeText(body.name);
  if (body.handle !== undefined) {
    // Validate handle format
    const h = String(body.handle).trim();
    if (!/^@?[a-z0-9_]{2,20}$/i.test(h)) {
      return jsonError("handle must be 2-20 alphanumeric characters (underscore allowed)", 400);
    }
    patch.handle = h.startsWith("@") ? h : "@" + h;
  }
  if (body.banner_gradient !== undefined) patch.banner_gradient = body.banner_gradient;
  if (body.avatar_gradient !== undefined) patch.avatar_gradient = body.avatar_gradient;

  // Language preference. Validated against the shared list rather than passed
  // through: the column has a CHECK constraint, so an unknown value would come
  // back as an opaque 500 instead of a clear 400.
  if (body.preferred_lang !== undefined) {
    if (!isPreferredLang(body.preferred_lang)) {
      return jsonError(`preferred_lang must be one of: ${PREFERRED_LANGS.join(", ")}`, 400);
    }
    patch.preferred_lang = body.preferred_lang;
  }

  if (Object.keys(patch).length === 0) {
    return jsonError("no fields to update", 400);
  }

  const { error } = await admin.from("users")
    .update(patch)
    .eq("id", user.id);

  if (error) return jsonError(dbErrorMessage("me", error), 500);

  // Sync name/handle/avatar_gradient to stores table (so product display stays fresh)
  const storePatch: Record<string, unknown> = {};
  if (patch.name !== undefined) storePatch.name = patch.name;
  if (patch.handle !== undefined) storePatch.handle = patch.handle;
  if (patch.avatar_gradient !== undefined) storePatch.avatar_gradient = patch.avatar_gradient;
  if (Object.keys(storePatch).length > 0) {
    storePatch.updated_at = new Date().toISOString();
    await admin.from("stores").update(storePatch).eq("owner_user_id", user.id);
  }

  return jsonOk({ ok: true });
}
