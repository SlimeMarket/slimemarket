/**
 * Admin/MM authentication — combo: PIN + UCW device approval.
 *
 * Flow for sensitive actions (admin OR middleman):
 *   1. User calls POST /api/admin/verify with { pin, challengeId }
 *   2. Server verifies PIN hash (3 attempts max) + confirms UCW challenge
 *   3. Returns a short-lived JWT "admin_action_token" (5 min TTL)
 *   4. User passes token in X-Admin-Token header on sensitive endpoints
 *
 * PIN lockout:
 *   - 3 failed attempts → account locked for 15 minutes
 *   - Reset only via email (POST /api/admin/pin/reset-request → sends code to email)
 *   - No web dashboard reset option (prevents attacker who hacked session)
 *
 * MM PIN:
 *   - Admin sets MM's PIN from dashboard (POST /api/admin/mm/[id]/set-pin)
 *   - MM uses the same verify flow before release/refund
 */

import crypto from "crypto";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { requireRole, getCurrentUser, type CurrentUser } from "@/lib/auth-ucw";
import { isWlStaff } from "@/lib/types";
import { jsonError } from "@/lib/utils";

// ===== PIN hashing (scrypt, no extra deps) =====

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELISM = 1; // p

export function hashPin(pin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(pin, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM,
    }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

export function verifyPin(pin: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return resolve(false);
    crypto.scrypt(pin, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM,
    }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(
        Buffer.from(hash, "hex"),
        derivedKey
      ));
    });
  });
}

// ===== PIN Attempt Tracking =====

export const MAX_ATTEMPTS = 3;
export const LOCKOUT_MINUTES = 15;

/**
 * PURE decision core for per-action admin PIN re-verification
 * (used by POST /api/admin/treasury/withdraw BEFORE any treasury movement).
 *
 * Returns one of:
 *   - { ok: true, resetAttempts: true }                       → proceed, reset pin_attempts
 *   - { ok: false, code: "ADMIN_PIN_NOT_SET" }                → 409, admin must set PIN first
 *   - { ok: false, code: "PIN_LOCKED", lockedUntil }          → 423, lockout active (or just triggered)
 *   - { ok: false, code: "INVALID_PIN", attemptsRemaining }   → 401, wrong PIN
 *
 * No DB access here — the caller loads the user row and persists the result.
 * On the 3rd failure this escalates to PIN_LOCKED (lockedUntil = now + 15 min).
 * An expired lockout resets the attempt budget and re-allows verification.
 */
export type CheckAdminPinArgs = {
  storedHash: string | null;
  attempts: number;
  lockedUntil: string | Date | null;
  pin: string;
  now: Date;
};

export type CheckAdminPinResult =
  | { ok: true; resetAttempts: true }
  | { ok: false; code: "INVALID_PIN"; attemptsRemaining: number }
  | { ok: false; code: "PIN_LOCKED"; lockedUntil: string }
  | { ok: false; code: "ADMIN_PIN_NOT_SET" };

export async function checkAdminPin(args: CheckAdminPinArgs): Promise<CheckAdminPinResult> {
  const { storedHash, pin, now } = args;
  const attempts = args.attempts ?? 0;
  const lockedUntil = args.lockedUntil ? new Date(args.lockedUntil) : null;

  if (!storedHash) return { ok: false, code: "ADMIN_PIN_NOT_SET" };

  // Active lockout wins even for the correct PIN.
  if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
    return { ok: false, code: "PIN_LOCKED", lockedUntil: lockedUntil.toISOString() };
  }

  // Expired lockout → fresh attempt budget.
  const effAttempts = lockedUntil ? 0 : attempts;

  const valid = await verifyPin(pin, storedHash);
  if (valid) return { ok: true, resetAttempts: true };

  const next = effAttempts + 1;
  if (next >= MAX_ATTEMPTS) {
    const lockUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60_000);
    return { ok: false, code: "PIN_LOCKED", lockedUntil: lockUntil.toISOString() };
  }
  return { ok: false, code: "INVALID_PIN", attemptsRemaining: MAX_ATTEMPTS - next };
}

// aliases for checkAdminPin callers.
export const ADMIN_PIN_MAX_ATTEMPTS = MAX_ATTEMPTS;
export const ADMIN_PIN_LOCKOUT_MINUTES = LOCKOUT_MINUTES;

export async function checkPinLockout(userId: string): Promise<{ locked: boolean; attemptsLeft: number }> {
  const admin = supabaseAdminClient();
  const { data } = await admin
    .from("users")
    .select("pin_attempts, pin_locked_until")
    .eq("id", userId)
    .single();

  if (!data) return { locked: false, attemptsLeft: MAX_ATTEMPTS };

  const lockedUntil = data.pin_locked_until ? new Date(data.pin_locked_until) : null;
  if (lockedUntil && lockedUntil > new Date()) {
    return { locked: true, attemptsLeft: 0 };
  }

  // If lockout expired, reset attempts
  if (lockedUntil && lockedUntil <= new Date()) {
    await admin.from("users").update({ pin_attempts: 0, pin_locked_until: null }).eq("id", userId);
    return { locked: false, attemptsLeft: MAX_ATTEMPTS };
  }

  const attempts = (data.pin_attempts as number) ?? 0;
  return { locked: false, attemptsLeft: MAX_ATTEMPTS - attempts };
}

export async function recordFailedAttempt(userId: string): Promise<{ locked: boolean; attemptsLeft: number }> {
  const admin = supabaseAdminClient();
  const { data } = await admin
    .from("users")
    .select("pin_attempts")
    .eq("id", userId)
    .single();

  const current = ((data?.pin_attempts as number) ?? 0) + 1;

  if (current >= MAX_ATTEMPTS) {
    // Lock for 15 minutes
    const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
    await admin.from("users").update({
      pin_attempts: current,
      pin_locked_until: lockUntil,
    }).eq("id", userId);
    return { locked: true, attemptsLeft: 0 };
  }

  await admin.from("users").update({ pin_attempts: current }).eq("id", userId);
  return { locked: false, attemptsLeft: MAX_ATTEMPTS - current };
}

export async function resetPinAttempts(userId: string): Promise<void> {
  const admin = supabaseAdminClient();
  await admin.from("users").update({ pin_attempts: 0, pin_locked_until: null }).eq("id", userId);
}

// ===== Admin Action Token (HMAC-signed, 5 min TTL) =====

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
// .A — never fall back to a hardcoded secret: an attacker who knows the
// literal "dev-admin-secret" could mint admin action tokens in production.
// Resolve lazily; hard-fail in production if unset. Dev gets a per-process
// random secret (tokens don't survive a restart, which is fine locally).
let _tokenSecret: string | null = null;
function tokenSecret(): string {
  if (_tokenSecret) return _tokenSecret;
  const s =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.CIRCLE_ENTITY_SECRET ||
    "";
  if (s) { _tokenSecret = s; return s; }
  if (process.env.NODE_ENV === "production") {
    throw new Error("admin token secret not configured (set SUPABASE_SECRET_KEY or CIRCLE_ENTITY_SECRET)");
  }
  _tokenSecret = `dev-${crypto.randomBytes(16).toString("hex")}`;
  return _tokenSecret;
}

interface AdminTokenPayload {
  sub: string; // user id
  role: string;
  iat: number;
  exp: number;
}

export function signAdminToken(userId: string, role: string): string {
  const payload: AdminTokenPayload = {
    sub: userId,
    role,
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", tokenSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyAdminToken(token: string): AdminTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", tokenSecret()).update(data).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload: AdminTokenPayload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (Date.now() > payload.exp) return null; // expired
    // 3 — accept Admin AND MM tokens. Safe: every sensitive
    // endpoint RE-checks the DB session role (requireAdminAuth → requireRole
    // "Admin"; requireStaffAuth → Admin||MM), so an MM token can only be
    // redeemed by the same MM session on MM-authorized routes.
    if (payload.role !== "Admin" && payload.role !== "MM") return null;
    return payload;
  } catch {
    return null;
  }
}

// ===== UCW Challenge Verification =====

const CIRCLE_API = process.env.NEXT_PUBLIC_CIRCLE_BASE_URL ?? "https://api.circle.com";

/**
 * Verify that a UCW challenge was successfully executed (device approval).
 * This confirms the user physically approved on their device.
 */
export async function verifyUcwChallenge(challengeId: string, userToken: string): Promise<boolean> {
  if (!challengeId || !userToken) return false;

  // In dev mode without Circle connectivity, allow bypass with magic challenge
  if (process.env.NODE_ENV !== "production" && challengeId === "dev-bypass") {
    return true;
  }

  try {
    const resp = await fetch(`${CIRCLE_API}/v1/w3s/challenges/${challengeId}`, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
    });
    const data = await resp.json();
    // Challenge status must be COMPLETE (user approved on device)
    return data.data?.status === "COMPLETE" || data.data?.status === "APPROVED";
  } catch (e) {
    console.error("UCW challenge verification failed:", e);
    return false;
  }
}

// ===== PIN Reset via Email =====

// In-memory store for reset codes (production: use Redis or DB table)
const resetCodes = new Map<string, { code: string; expiresAt: number }>();

export function generateResetCode(userId: string): string {
  const code = crypto.randomInt(100000, 999999).toString();
  resetCodes.set(userId, { code, expiresAt: Date.now() + 10 * 60_000 }); // 10 min
  return code;
}

export function verifyResetCode(userId: string, code: string): boolean {
  const entry = resetCodes.get(userId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    resetCodes.delete(userId);
    return false;
  }
  if (entry.code !== code) return false;
  resetCodes.delete(userId);
  return true;
}

// ===== Route Guard =====

/**
 * Require an Admin session for sensitive actions.
 *
 * The PIN + UCW step-action token was REMOVED at the owner's request
 * (hackathon speedrun): the Circle email-OTP session carrying the Admin role
 * is now the single gate. If a caller still sends X-Admin-Token (e.g. an
 * older tab), it is validated and must match the session user — but it is
 * optional.
 */
export async function requireAdminAuth(req: Request): Promise<
  { user: CurrentUser; error: null } | { user: null; error: Response }
> {
  let user: CurrentUser;
  try {
    user = await requireRole("Admin");
  } catch {
    return { user: null, error: jsonError("Admin role required", 403) };
  }

  const token = req.headers.get("x-admin-token");
  if (token) {
    const payload = verifyAdminToken(token);
    if (!payload) {
      return { user: null, error: jsonError("Invalid or expired admin token.", 401) };
    }
    if (payload.sub !== user.id) {
      return { user: null, error: jsonError("Admin token does not match current session", 403) };
    }
  }

  return { user, error: null };
}

/**
 * 3 — Admin OR MM variant for WL escrow deal release/refund.
 * Same session-role gate (Admin||MM); the PIN step-action token was removed
 * at the owner's request — a presented token is still validated but optional.
 */
export async function requireStaffAuth(req: Request): Promise<
  { user: CurrentUser; error: null } | { user: null; error: Response }
> {
  let user: CurrentUser | null;
  try {
    user = await getCurrentUser();
  } catch {
    return { user: null, error: jsonError("Admin/MM role required", 403) };
  }
  if (!user || !isWlStaff(user.role)) {
    return { user: null, error: jsonError("Admin/MM role required", 403) };
  }

  const token = req.headers.get("x-admin-token");
  if (token) {
    const payload = verifyAdminToken(token);
    if (!payload) {
      return { user: null, error: jsonError("Invalid or expired staff token.", 401) };
    }
    if (payload.sub !== user.id) {
      return { user: null, error: jsonError("Staff token does not match current session", 403) };
    }
  }

  return { user, error: null };
}

export async function getAdminPinHash(userId: string): Promise<string | null> {
  const admin = supabaseAdminClient();
  const { data } = await admin
    .from("users")
    .select("admin_pin_hash")
    .eq("id", userId)
    .single();
  return data?.admin_pin_hash ?? null;
}

export async function setAdminPinHash(userId: string, hash: string): Promise<void> {
  const admin = supabaseAdminClient();
  const { error } = await admin
    .from("users")
    .update({ admin_pin_hash: hash, pin_attempts: 0, pin_locked_until: null })
    .eq("id", userId);
  if (error) throw new Error(`Failed to set admin PIN: ${error.message}`);
}
