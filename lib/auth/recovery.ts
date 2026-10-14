import { randomBytes } from "crypto";
import { verifyMessage } from "viem";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * wallet-based (EOA) account recovery.
 *
 * TWO flows share this module:
 *
 *  1. link_wallet   — a logged-in user proves ownership of an external EOA
 *                     (MetaMask etc.) and we store it in recovery_wallets.
 *  2. recovery_login— someone who lost their inbox signs the same style of
 *                     message with a LINKED EOA and gets a data-access session.
 *
 * The message is domain-bound + nonce-bound so a signature cannot be replayed
 * on another origin or reused after a single login attempt.
 *
 * NOT usable for Circle UCW wallets: their keys are MPC-split and only Circle
 * can sign — and a Circle signing session itself requires an email OTP. That
 * limitation is documented in HANDOFF §14.
 */

export const RECOVERY_PURPOSES = {
  LOGIN: "recovery_login",
  LINK: "link_wallet",
} as const;

export type RecoveryPurpose =
  (typeof RECOVERY_PURPOSES)[keyof typeof RECOVERY_PURPOSES];

/** Nonce lifetime for both flows. */
export const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface RecoveryMessageInput {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: string;
  purpose: RecoveryPurpose;
}

/**
 * Deterministic human-readable message the wallet signs (EIP-191 personal_sign).
 * Pure — the exact string is asserted by tests so a silent format change can
 * never invalidate already-issued signatures without a failing test.
 */
export function buildRecoveryMessage(input: RecoveryMessageInput): string {
  const addr = input.address.trim().toLowerCase();
  return [
    "SlimeMarket wallet recovery",
    "",
    `Domain: ${input.domain}`,
    `Address: ${addr}`,
    `Purpose: ${input.purpose}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

/**
 * Verify an EIP-191 signature over `message` was produced by `address`.
 * Pure, no I/O. Never throws — malformed signatures/addresses return false.
 */
export async function verifyRecoverySignature(params: {
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  const { address, message, signature } = params;
  if (!address || !message || !signature) return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    // Normalize address to lowercase for viem compatibility
    const normalizedAddress = address.trim().toLowerCase() as `0x${string}`;
    return await verifyMessage({
      address: normalizedAddress,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Nonce store (single-use, TTL, purpose- and address-bound)
// ---------------------------------------------------------------------------

/** Issue a fresh nonce. Optionally bind it to an address and/or user. */
export async function issueNonce(params: {
  purpose: RecoveryPurpose;
  address?: string | null;
  userId?: string | null;
}): Promise<{ nonce: string; issuedAt: string; expiresAt: string }> {
  const admin = supabaseAdminClient();
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);

  const { error } = await admin.from("auth_nonces").insert({
    nonce,
    purpose: params.purpose,
    address: params.address ? params.address.trim().toLowerCase() : null,
    user_id: params.userId ?? null,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw new Error(`auth_nonces insert failed: ${error.message}`);

  return {
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * The domain bound into the signed message. Prefers the configured public app
 * URL (same value CSRF trusts); falls back to the request origin for dev.
 */
export function recoveryDomainFromRequest(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured && configured.trim()) return configured.trim();
  try {
    return new URL(req.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}

/**
 * Atomically consume a nonce: marks used_at only when it is still unused,
 * unexpired, of the right purpose, and (when the caller supplies one) bound to
 * the same address. The conditional UPDATE ... RETURNING makes replay
 * impossible even under concurrent requests — a second caller updates 0 rows.
 */
export async function consumeNonce(params: {
  nonce: string;
  purpose: RecoveryPurpose;
  address: string;
}): Promise<{ ok: boolean; userId: string | null; issuedAt: string | null; reason?: string }> {
  const admin = supabaseAdminClient();
  const addr = params.address.trim().toLowerCase();

  const { data, error } = await admin
    .from("auth_nonces")
    .update({ used_at: new Date().toISOString(), consumed_by: addr })
    .eq("nonce", params.nonce)
    .eq("purpose", params.purpose)
    .eq("address", addr)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("id, user_id, issued_at");

  if (error) return { ok: false, userId: null, issuedAt: null, reason: error.message };
  if (!data || data.length === 0) {
    // Unknown / expired / already-used / wrong-address nonce — all rejected
    // identically so the response can't be used to probe nonce state.
    return { ok: false, userId: null, issuedAt: null, reason: "invalid-or-expired-nonce" };
  }
  // Normalize issued_at to ISO string (handles TIMESTAMPTZ format differences
  // between insert and select — e.g. "+00:00" vs "Z" suffix).
  const rawIssuedAt = data[0].issued_at as string | null;
  const normalizedIssuedAt = rawIssuedAt ? new Date(rawIssuedAt).toISOString() : null;
  return {
    ok: true,
    userId: (data[0].user_id as string | null) ?? null,
    issuedAt: normalizedIssuedAt,
  };
}

// ---------------------------------------------------------------------------
// Recovery wallet registry
// ---------------------------------------------------------------------------

export interface RecoveryWalletRow {
  id: string;
  address: string;
  chainId: number;
  label: string | null;
  linkedAt: string;
  lastUsedAt: string | null;
}

/** All recovery wallets for a user. */
export async function listRecoveryWallets(userId: string): Promise<RecoveryWalletRow[]> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("recovery_wallets")
    .select("id, address, chain_id, label, linked_at, last_used_at")
    .eq("user_id", userId)
    .order("linked_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    address: r.address as string,
    chainId: (r.chain_id as number) ?? 5042002,
    label: (r.label as string | null) ?? null,
    linkedAt: r.linked_at as string,
    lastUsedAt: (r.last_used_at as string | null) ?? null,
  }));
}

/** Resolve an EOA to its owning account (case-insensitive). */
export async function findUserByRecoveryWallet(
  address: string,
): Promise<{ userId: string; walletId: string } | null> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("recovery_wallets")
    .select("id, user_id")
    .ilike("address", address.trim()) // address stored lowercased; ilike keeps it case-insensitive
    .maybeSingle();
  if (error || !data) return null;
  return { userId: data.user_id as string, walletId: data.id as string };
}

/**
 * Link an EOA to an account. Fails when the address already belongs to
 * ANOTHER account (unique index on lower(address)) — that guard is what makes
 * cross-account takeover via a shared wallet impossible.
 */
export async function linkRecoveryWallet(params: {
  userId: string;
  address: string;
  label?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const admin = supabaseAdminClient();
  const addr = params.address.trim().toLowerCase();

  const existing = await findUserByRecoveryWallet(addr);
  if (existing && existing.userId !== params.userId) {
    return { ok: false, error: "wallet already linked to another account", status: 409 };
  }
  if (existing && existing.userId === params.userId) {
    const { error } = await admin
      .from("recovery_wallets")
      .update({ label: params.label ?? null })
      .eq("id", existing.walletId);
    if (error) return { ok: false, error: error.message, status: 500 };
    return { ok: true };
  }

  const { error } = await admin.from("recovery_wallets").insert({
    user_id: params.userId,
    address: addr,
    chain_id: 5042002,
    label: params.label ?? null,
  });
  if (error) return { ok: false, error: error.message, status: 500 };
  return { ok: true };
}

/** Remove a recovery wallet (only if it belongs to this user). */
export async function unlinkRecoveryWallet(params: {
  userId: string;
  address: string;
}): Promise<boolean> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("recovery_wallets")
    .delete()
    .eq("user_id", params.userId)
    .ilike("address", params.address.trim())
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** Stamp last_used_at after a successful recovery login (best-effort). */
export async function touchRecoveryWallet(address: string): Promise<void> {
  try {
    const admin = supabaseAdminClient();
    await admin
      .from("recovery_wallets")
      .update({ last_used_at: new Date().toISOString() })
      .ilike("address", address.trim());
  } catch {
    // never fails the login
  }
}
