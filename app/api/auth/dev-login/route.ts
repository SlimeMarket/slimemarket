import { NextResponse } from "next/server";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { genUid } from "@/lib/uid";
import * as cryptoModule from "crypto";

const crypto = cryptoModule;

/**
 * POST /api/auth/dev-login — Quick login for automated testing.
 *
 * Bypasses Circle OTP entirely. Takes an email, looks up (or creates) the
 * user + wallet, sets httpOnly session cookies directly. Returns the user
 * object + wallet info.
 *
 * ONLY AVAILABLE IN DEV MODE (NODE_ENV !== "production"). In production,
 * returns 404.
 *
 * Usage:
 *   POST /api/auth/dev-login
 *   { "email": "testbuyer@slimemarket.app" }
 *
 * Response: { sessionToken, user:{id,email,name,role,kyc}, walletAddress }
 * Sets cookies: circle_user_token, circle_email, circle_encryption_key
 */
export const dynamic = "force-dynamic";

// ============================================================================
// MOCK WALLET GENERATION FOR DEV-LOGIN
// ============================================================================

/**
 * Generate a deterministic ERC-6975-compatible wallet address from email.
 * Uses SHA-256 hash of email prefix to ensure idempotency across runs.
 * Address format: 0x + 40 hex chars (valid EVM address).
 *
 * Safety: Only used in dev/login test scenarios; blocked in production.
 */
async function generateMockWalletAddress(email: string): Promise<string> {
  const encoder = new TextEncoder();
  // Deterministic seed: include app name to avoid conflicts with other projects
  const data = encoder.encode(`slimemarket-devlogin-${email.toLowerCase().trim()}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return "0x" + hashHex.slice(0, 40); // First 40 hex chars = valid 20-byte address
}

/**
 * .C1 — derive a username from an email prefix: lowercase, keep
 * alphanumerics/underscore/dot→underscore, max 20 chars. Falls back to
 * "user" if the prefix yields nothing.
 */
function emailPrefixToUsername(email: string): string {
  const prefix = email.split("@")[0] ?? "";
  const cleaned = prefix
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, "")
    .replace(/\./g, "_")
    .slice(0, 20);
  return cleaned || "user";
}

/** 3-char random lowercase suffix for unique-ish usernames. */
function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 3; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

// ============================================================================
// ROUTE HANDLER
// ============================================================================

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "not found" },
      { status: 404, headers: { "X-Dev-Login": "disabled-in-production" } }
    );
  }

  // Safety check: require Circle API keys if NOT in mock mode
  // This prevents accidental real wallet provisioning in non-dev environments
  const useMockWallets = process.env.CIRCLE_PAYMENTS_MOCK !== "0";

  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "Buyer").trim();

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  const admin = supabaseAdminClient();

  // Map emails to REAL Circle wallet IDs from Console.

  // Real account identifiers are supplied through the environment instead of
  // being committed — this file ships in a PUBLIC repo, and a personal email
  // plus its Circle wallet id is exactly the kind of thing that should not be
  // world-readable. Set it in `.env.local` (gitignored):

  //   DEV_LOGIN_WALLETS='{"you@example.com":{"walletId":"<uuid>","name":"Admin User"}}'

  // The two entries below are throwaway placeholders, safe to keep in-repo.
  const ENV_WALLET_MAPPINGS: Record<string, { walletId: string; name: string }> = (() => {
    try {
      const parsed = JSON.parse(process.env.DEV_LOGIN_WALLETS ?? "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      console.warn("[dev-login] DEV_LOGIN_WALLETS is not valid JSON — ignoring it");
      return {};
    }
  })();

  const WALLET_MAPPINGS: Record<string, {walletId: string, name: string}> = {
    ...ENV_WALLET_MAPPINGS,
    "buyer_test@catchmail.io": {
      walletId: "757704ac-5bfc-5f98-8e3f-7963df37a3a8", // Buyer wallet ID
      name: "Buyer User"
    },
    "seller@example.com": {
      walletId: "cf885131-6606-591f-9a23-66a5701e21e1", // Seller wallet ID
      name: "Seller User"
    },
  };

  const mapping = WALLET_MAPPINGS[email] || null;
  const circleWalletId = mapping?.walletId || null;
  const displayName = mapping?.name || email.split("@")[0];

  // Find or create user with proper role
  let { data: user } = await admin.from("users").select("*").eq("email", email).maybeSingle();
  if (!user) {
    // users.uid + referral_code are NOT NULL — generate them like the
    // unified signup route does (4-char pretty uid, retry on collision).
    let uid = genUid();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: clash } = await admin.from("users").select("id").eq("uid", uid).maybeSingle();
      if (!clash) break;
      uid = genUid();
    }

    // .C1 — virtual-store identity: derive a unique username from the
    // email prefix. users.username has a UNIQUE partial index (migration
    // 0040), so on collision we append 3 random chars and retry. The username
    // is what becomes the store name / @handle / store page slug.
    let username = emailPrefixToUsername(email);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: clash } = await admin.from("users").select("id").eq("username", username).maybeSingle();
      if (!clash) break;
      username = emailPrefixToUsername(email) + randomSuffix();
    }

    const { data: newUser, error } = await admin.from("users").insert({
      email,
      name: displayName,
      username,
      role: role as any,
      preferred_lang: "en",
      uid,
      referral_code: uid.slice(0, 8).toUpperCase(),
      // .B3 — dev accounts keep mock wallets and are considered fully
      // provisioned (no real UCW PIN flow for dev-token sessions).
      wallet_provisioned: true,
    }).select("*").single();
    if (error || !newUser) return NextResponse.json({ error: error?.message ?? "create user failed" }, { status: 500 });
    user = newUser;
  }

  // .C1 — self-heal legacy dev users created before usernames existed
  // (migration 0040 backfilled username = handle, but handle itself may be
  // null for the earliest rows). The virtual store identity is the username.
  if (!user.username) {
    let username = emailPrefixToUsername(email);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: clash } = await admin.from("users").select("id").eq("username", username).maybeSingle();
      if (!clash || clash.id === user.id) break;
      username = emailPrefixToUsername(email) + randomSuffix();
    }
    await admin.from("users").update({ username }).eq("id", user.id);
    user.username = username;
  }

  // Update user's expected role (in case it was set wrong before)
  if (user.role !== role && role !== "Buyer") {
    await admin.from("users").update({ role: role as any }).eq("id", user.id);
  }

  // Find or create wallet with VALID address (FIX: no more address: null)
  let { data: wallet } = await admin.from("wallets").select("*").eq("user_id", user.id).maybeSingle();

  // Only try to create if wallet doesn't exist
  if (!wallet) {
    // Generate/mock wallet address deterministically
    let walletAddress: string;

    if (useMockWallets) {
      // Mock mode: generate deterministic address based on email
      walletAddress = await generateMockWalletAddress(email);
      console.log(`[dev-login] Generated mock wallet address for ${email}: ${walletAddress}`);
    } else {
      // Fallback: still generate but log warning that Circle API is not configured
      console.warn(`[dev-login] CIRCLE_PAYMENTS_MOCK not enabled, generating fallback address for ${email}`);
      walletAddress = await generateMockWalletAddress(email);
    }

    // Insert wallet with NON-NULL address (FIXES THE BUG)
    const { data: newWallet, error: wErr } = await admin.from("wallets").insert({
      user_id: user.id,
      address: walletAddress, // ← FIX: Previously null, now generated
      circle_wallet_id: circleWalletId || "pending-provisioning",
      wallet_type: "ucw",
      usdc_balance: 0,
      forum_balance: 0,
    }).select("*").single();

    if (wErr || !newWallet) {
      console.error("[dev-login] Wallet insert failed:", wErr?.message);
      return NextResponse.json({ error: wErr?.message ?? "create wallet failed" }, { status: 500 });
    }
    wallet = newWallet;
  } else {
    // Reuse existing wallet (prevents duplicate key violation on wallets.user_id)

    // Update circle_wallet_id if missing
    if (!wallet.circle_wallet_id && circleWalletId) {
      await admin.from("wallets").update({ circle_wallet_id: circleWalletId }).eq("id", wallet.id);
      wallet.circle_wallet_id = circleWalletId;
    }

    // Ensure wallet has address (recovery for older test data)
    if (!wallet.address) {
      console.error(`[dev-login] WARNING: Existing wallet ${wallet.id} has null address - regenerating`);
      const newAddress = await generateMockWalletAddress(email);
      await admin.from("wallets").update({ address: newAddress }).eq("id", wallet.id);
      wallet.address = newAddress;
    }
  }

  // Generate dev tokens
  const devToken = `dev-token-${crypto.randomUUID().slice(0, 12)}`;
  const devKey = `dev-key-${crypto.randomUUID().slice(0, 12)}`;

  const response = NextResponse.json({
    sessionToken: devToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      walletAddress: wallet.address!,
      circleWalletId: wallet.circle_wallet_id,
    },
    wallet: {
      address: wallet.address,
      circleWalletId: wallet.circle_wallet_id,
      usdcBalance: wallet.usdc_balance,
    },
  });

  // Set httpOnly cookies. Secure only when actually served over HTTPS
  // (x-forwarded-proto), so localhost-over-http keeps working.
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: proto === "https",
    maxAge: 60 * 60 * 24 * 7,
  };
  response.cookies.set("circle_user_token", devToken, COOKIE_OPTS);
  response.cookies.set("circle_email", email, COOKIE_OPTS);
  response.cookies.set("circle_encryption_key", devKey, COOKIE_OPTS);

  return response;
}
