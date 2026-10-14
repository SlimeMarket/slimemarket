import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { Role, PreferredLang } from "@/lib/types";

export interface CurrentUser {
  id: string;
  uid: string;
  name: string;
  username: string;
  handle: string;
  email: string;
  role: Role;
  txCount: number;
  avatarUrl: string | null;
  avatarGradient: string | null;
  bannerGradient: string | null;
  preferredLang: PreferredLang;
  contacts: Record<string, string>;
  joinedAt: string;
  circleUserId: string;
  walletAddress: string | null;
  circleWalletId: string | null;
  banned: boolean;
  bannedReason: string | null;
  walletProvisioned: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const userToken = cookieStore.get("circle_user_token")?.value;
  const email = cookieStore.get("circle_email")?.value;
  if (!userToken || !email) return null;

  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("users")
    .select(`
      id, uid, name, username, handle, email, role, tx_count, avatar_url, avatar_gradient,
      banner_gradient, preferred_lang, contacts, joined_at, circle_user_id,
      banned, banned_reason, banned_until, wallet_provisioned
    `)
    .eq("email", email)
    .maybeSingle();

  if (error || !data) return null;

  // P1-6 FIX: Enforce ban status — banned users cannot authenticate.
  // A ban is active if banned=true AND (banned_until is null = permanent, OR banned_until > now).
  if (data.banned) {
    const banUntil = data.banned_until ? new Date(data.banned_until) : null;
    if (!banUntil || banUntil > new Date()) {
      // Ban is still active — reject authentication
      return null;
    }
    // Ban has expired — could auto-unban here, but for now just allow through
  }

  const { data: wallet } = await admin
    .from("wallets")
    .select("address, circle_wallet_id")
    .eq("user_id", data.id)
    .maybeSingle();

  return {
    ...shapeCurrentUser(data),
    walletAddress: wallet?.address ?? null,
    circleWalletId: wallet?.circle_wallet_id ?? null,
  };
}

/**
 * Map a raw `users` table row to the CurrentUser response shape.
 * Pure function (no DB / cookies) so it is unit-testable.
 */
export function shapeCurrentUser(row: Record<string, unknown>): Omit<CurrentUser, "walletAddress" | "circleWalletId"> {
  return {
    id: row.id as string,
    uid: row.uid as string,
    name: row.name as string,
    // username (migration 0040) is the virtual-store identity. Falls back to
    // the handle (without leading @) or display name for legacy rows that
    // were created before usernames existed.
    username: (row.username as string)
      ?? String(row.handle ?? row.name ?? "").replace(/^@/, ""),
    handle: row.handle as string,
    email: row.email as string,
    role: row.role as Role,
    txCount: row.tx_count as number,
    avatarUrl: row.avatar_url as string | null,
    avatarGradient: row.avatar_gradient as string | null,
    bannerGradient: row.banner_gradient as string | null,
    preferredLang: row.preferred_lang as PreferredLang,
    contacts: (row.contacts as Record<string, string>) ?? {},
    joinedAt: row.joined_at as string,
    circleUserId: row.circle_user_id as string,
    banned: (row.banned as boolean) ?? false,
    bannedReason: (row.banned_reason as string) ?? null,
    walletProvisioned: row.wallet_provisioned === true,
  };
}

/**
 * .B3 — is the current session a dev-login session? Dev sessions use a
 * `dev-token-…` userToken cookie (see app/api/auth/dev-login) and keep
 * DB-only mock wallets; they must NEVER trigger real UCW provisioning
 * (Circle rejects dev tokens with 401, and Playwright automation relies on
 * the mock path).
 */
export async function isDevTokenSession(): Promise<boolean> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const userToken = cookieStore.get("circle_user_token")?.value;
  return !!userToken && userToken.startsWith("dev-token-");
}

export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) {
    const err = new Error("UNAUTHORIZED");
    (err as Error & { status?: number }).status = 401;
    throw err;
  }
  return u;
}

export async function requireRole(min: Role): Promise<CurrentUser> {
  const u = await requireUser();
  const { ROLE_RANK } = await import("@/lib/types");
  if (ROLE_RANK[u.role] < ROLE_RANK[min]) {
    const err = new Error("FORBIDDEN");
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  return u;
}

/**
 * Read the buyer's Circle UCW credentials (userToken + encryptionKey) from
 * the session cookies. Both are required to issue a Circle challenge (e.g.
 * `W3SSdk.execute(challengeId)` for a UCW `CONTRACT_EXECUTION` approve call).
 *
 * Returns null if either cookie is missing — the caller should redirect the
 * user to the refresh-session page to re-establish UCW credentials.
 *
 * Note: the `circle_user_token` cookie is also what authenticates the session
 * (see `getCurrentUser`), but the `encryption_key` cookie is only needed for
 * UCW challenge approval. Both have a 7-day TTL set at signup
 * (`app/api/auth/unified/route.ts`).
 *
 * SECURITY: these credentials are server-side only (httpOnly cookies). The FE
 * must NOT receive them in API responses — instead, the FE uses the W3S SDK
 * with credentials it obtained at signup (mirrored to localStorage; see
 * `public/auth.jsx`).
 */
export async function getUcwCredentials(): Promise<{
  userToken: string;
  encryptionKey: string;
  circleWalletId: string | null;
} | null> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const userToken = cookieStore.get("circle_user_token")?.value;
  const encryptionKey = cookieStore.get("circle_encryption_key")?.value;
  if (!userToken || !encryptionKey) return null;

  // Look up the user's Circle wallet id (needed to target the UCW challenge).
  const email = cookieStore.get("circle_email")?.value;
  if (!email) return null;
  const admin = supabaseAdminClient();
  const { data: user } = await admin.from("users").select("id").eq("email", email).maybeSingle();
  if (!user) return null;
  const { data: wallet } = await admin.from("wallets")
    .select("circle_wallet_id").eq("user_id", user.id).maybeSingle();

  return {
    userToken,
    encryptionKey,
    circleWalletId: wallet?.circle_wallet_id ?? null,
  };
}
