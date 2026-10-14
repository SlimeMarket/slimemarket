import { NextResponse } from "next/server";
import { jsonOk, jsonError } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { genUid } from "@/lib/uid";
import { getCircleUserStatus, challengeForProvisioningAction } from "@/lib/circle/ucw-user";
import { decideProvisioning } from "@/lib/circle/ucw-provisioning";
import { checkUserRateLimit } from "@/lib/rate-limit";

/**
 * Build session cookie options. The `secure` flag is derived from the ACTUAL
 * request protocol (x-forwarded-proto) instead of NODE_ENV, so that:
 *  - HTTPS production: Secure cookies work normally
 *  - HTTP dev/local (next start over http://localhost): Secure flag is OFF so
 *    the browser actually stores the cookies (prevents logout-on-reload).
 */
function sessionCookieOpts(req: Request) {
  // Behind a proxy/CDN (Vercel, nginx) x-forwarded-proto is set. Direct
  // localhost access has no header → treated as http.
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: proto === "https",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  };
}

function withSessionCookies(
  req: Request,
  res: NextResponse,
  opts: { userToken: string; email: string; encryptionKey?: string }
) {
  const cookieOpts = sessionCookieOpts(req);
  res.cookies.set("circle_user_token", opts.userToken, cookieOpts);
  res.cookies.set("circle_email", opts.email, cookieOpts);
  if (opts.encryptionKey) {
    res.cookies.set("circle_encryption_key", opts.encryptionKey, cookieOpts);
  }
  return res;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  // Rate limit: 10 login attempts per minute per IP to prevent brute-force
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rlErr = await checkUserRateLimit(ip, "login-attempts", {
    max: 10,
    windowMs: 60 * 1000, // 10 per minute per IP
  });
  if (rlErr) return jsonError(`Too many login attempts. Please try again later.`, 429);

  const userToken = String(body.userToken ?? "");
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? email.split("@")[0] ?? "User");
  const encryptionKey = String(body.encryptionKey ?? "");
  const requestedUsername = String(body.username ?? "").trim().toLowerCase();

  if (!userToken || !email) return jsonError("userToken and email required", 400);

  // Validate requested username format early (uniqueness is checked at insert
  // time, only for new users — existing users keep their current username).
  if (requestedUsername) {
    if (requestedUsername.length < 3 || requestedUsername.length > 20) {
      return jsonError("username must be 3-20 characters", 400);
    }
    if (!/^[a-z0-9_]+$/.test(requestedUsername)) {
      return jsonError("username can only contain lowercase letters, numbers, and underscores", 400);
    }
  }

  // 1. List user wallets from Circle UCW (skip in dev mode with dev token)
  let primaryWallet: { address: string; id: string } | null = null;
  const circleUserId: string | null = null;

  if (userToken.startsWith("dev-token-")) {
    // Dev mode: skip Circle API but provision a MOCK wallet so local flows
    // (faucet, balance, checkout) work end-to-end. circle_wallet_id starts with
    // "mock-" so the faucet applies a DB-only credit (no on-chain transfer).
    const devAddr =
      "0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(20)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    primaryWallet = { address: devAddr, id: "mock-" + userToken };
  } else {
    // P0-1 FIX: Verify the userToken against Circle's API before trusting the email.
    // This prevents token-email mismatch attacks (valid token for user A + email of user B).
    const circleBase = process.env.NEXT_PUBLIC_CIRCLE_BASE_URL ?? "https://api.circle.com";

    // 1a. Validate the userToken, and opportunistically capture the Circle id.

    // BUG FIX (BUG 14): this previously called `GET /v1/w3s/users` (a *list*
    // endpoint) and read `users[0].userId` / `users[0].email` — NEITHER field
    // exists on Circle's EndUser object. The real shape is:
    //   { id, status, createDate, pinStatus, pinDetails,
    //     securityQuestionStatus, securityQuestionDetails, authMode }
    // Consequence: `circle_user_id` was written as null for 100% of accounts
    // (0/13 rows), and the email-mismatch guard below silently never fired.

    // The identity is already known locally: `lib/uid.ts` documents that the
    // 4-char `uid` IS the Circle UCW userId (createUser({ userId: uid })), and
    // Circle echoes it back only as the opaque `id`. So we no longer depend on
    // a network response for `circleUserId` — we authoritatively set it from
    // the user row after the upsert (see step 2).

    // Validate the token with `GET /v1/w3s/wallets`.

    // BUG FIX: this used `GET /v1/w3s/users/token`, which answers
    // 404 {code:155102,"Cannot find the userId in the system"} for a token whose
    // user has NO WALLET YET — i.e. for exactly the users who are signing up for
    // the first time. The route read that as "invalid session token" and returned
    // 401, so a brand-new UCW user could never establish a session, and the whole
    // on-chain path was unreachable.

    // Verified live: the same token that /users/token rejects with 155102 returns
    // 200 {"data":{"wallets":[]}} from /wallets. So /wallets is the correct probe
    // a bad token still fails it, but a valid token for an uninitialised user
    // passes and yields an empty list, which is the expected pre-initialize state.
    try {
      const userResp = await fetch(`${circleBase}/v1/w3s/wallets`, {
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
          "X-User-Token": userToken,
        },
      });
      if (userResp.ok) {
        const userData = await userResp.json();
        // `circleUserId` is authoritative from the local row (lib/uid.ts: the
        // 4-char uid IS the Circle UCW userId) — see step 2. Nothing to read here.
        void userData;
      } else {
        // Token is not recognised by Circle → reject rather than mint a session
        // for a token that cannot sign anything.
        const errBody = await userResp.json().catch(() => ({}));
        console.error("Circle userToken validation failed:", userResp.status, errBody?.code);
        return jsonError("invalid session token", 401);
      }
    } catch (e) {
      console.error("Circle user verification failed:", e);
    }

    // 1b. There is no email to cross-check: Circle's EndUser object has no
    // `email` field, so a token-vs-email guard can never fire. The wallets call
    // below is the real second layer of validation — it fails for a bad token.
    // (The guard that used to sit here was dead code for that reason.)

    // 1c. List user wallets from Circle UCW
    const resp = await fetch(
      `${circleBase}/v1/w3s/wallets`,
      {
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
          "X-User-Token": userToken,
        },
      }
    );
    const walletData = await resp.json();
    const wallets = walletData.data?.wallets ?? [];
    primaryWallet = wallets[0] ?? null;
  }

  // 2. Upsert user in Supabase
  const admin = supabaseAdminClient();

  // 2a. First: try to find user by email
  let { data: existing } = await admin
    .from("users")
    .select("id, uid, name, handle, username, role, tx_count, wallet_provisioned, circle_user_id")
    .eq("email", email)
    .maybeSingle();

  // 2b. If not found by email, try wallet address matching (restore after DB reset)
  if (!existing && primaryWallet?.address) {
    const { data: existingWallet } = await admin
      .from("wallets")
      .select("user_id, address")
      .eq("address", primaryWallet.address)
      .maybeSingle();

    if (existingWallet?.user_id) {
      // Wallet exists → restore user (preserve original UID, role, data)
      const { data: restoredUser } = await admin
        .from("users")
        .select("id, uid, name, handle, username, role, tx_count, wallet_provisioned, circle_user_id, email")
        .eq("id", existingWallet.user_id)
        .maybeSingle();

      if (restoredUser) {
        // Update email if it changed in Circle but wallet is same
        if (email && restoredUser.email !== email) {
          await admin.from("users").update({ email }).eq("id", restoredUser.id);
        }
        existing = restoredUser as any;
      }
    }
  }

  let userId: string;
  let publicUid: string;
  let role = "Member";
  let txCount = 0;
  let displayName = name;
  let handle = "@" + name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let username: string | null = null;
  let provisioned = false;

  if (existing) {
    userId = existing.id;
    publicUid = existing.uid as string;
    role = existing.role as string;
    txCount = existing.tx_count as number;
    displayName = (existing.name as string) || name;
    handle = (existing.handle as string) || handle;
    username = (existing.username as string) ?? null;
    provisioned = existing.wallet_provisioned === true;
    // BUG 14 FIX: `uid` IS the Circle UCW userId (see lib/uid.ts), so this is
    // authoritative — no dependence on the Circle response shape. Prefer the
    // id Circle reported when present, else fall back to our own uid.
    const desiredCuid = circleUserId || publicUid || null;
    if (desiredCuid && existing.circle_user_id !== desiredCuid) {
      await admin.from("users").update({ circle_user_id: desiredCuid }).eq("id", userId);
    }
  } else {
    // Generate a unique pretty UID, retrying on collision.
    let uid = genUid();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: clash } = await admin.from("users").select("id").eq("uid", uid).maybeSingle();
      if (!clash) break;
      uid = genUid();
    }
    publicUid = uid;

    // Resolve username: use the requested one (format validated above) after a
    // uniqueness check, or generate from the email prefix with a random suffix
    // if the base is taken.
    if (requestedUsername) {
      const { data: unameClash } = await admin
        .from("users").select("id").eq("username", requestedUsername).maybeSingle();
      if (unameClash) return jsonError("username is already taken", 409);
      username = requestedUsername;
    } else {
      let base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 14);
      if (base.length < 3) base = (base + "user").slice(0, 14);
      username = base;
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data: clash } = await admin
          .from("users").select("id").eq("username", username).maybeSingle();
        if (!clash) break;
        username = (base + "_" + Math.random().toString(36).slice(2, 6)).slice(0, 20);
      }
    }
    handle = "@" + username;

    const { data: created, error: createErr } = await admin
      .from("users")
      .insert({
        uid,
        name,
        handle,
        username,
        email,
        role: "Member",
        tx_count: 0,
        referral_code: uid.slice(0, 8).toUpperCase(),
        preferred_lang: "en",
        contacts: {},
        joined_at: new Date().toISOString(),
        // BUG 14 FIX: `uid` IS the Circle UCW userId (createUser({ userId: uid })).
        // Circle's EndUser object does not carry a `userId` field, so relying on
        // the API response used to write null for every account.
        circle_user_id: circleUserId || uid,
      })
      .select("id")
      .single();

    if (createErr) return jsonError(createErr.message, 500);
    userId = created.id;

    // The referral feature has been REMOVED. This used to seed a `referrals` row
    // here; that table is now dormant and nothing reads or writes it.

    // `users.referral_code` is still populated above — it is a NOT NULL column,
    // so registration would fail without a value. It is no longer surfaced by any
    // API response, and the column can be dropped together with the `referrals` /
    // `referral_events` tables once you are sure you will not re-enable this.
  }

  // 3. Upsert wallet row (.B2). A real Circle wallet is re-persisted on
  //    every login so a locally-stored legacy/mock address can't linger; dev
  //    (mock-*) wallets are insert-only to stay idempotent.
  let realWalletStored = false;
  if (primaryWallet) {
    const isRealWallet =
      !!primaryWallet.address && !primaryWallet.id.startsWith("mock-");

    if (isRealWallet) {
      // upsert keyed on the UNIQUE wallets.user_id constraint.
      await admin
        .from("wallets")
        .upsert(
          {
            user_id: userId,
            address: primaryWallet.address,
            circle_wallet_id: primaryWallet.id,
            wallet_type: "ucw",
          },
          { onConflict: "user_id" },
        );
      realWalletStored = true;
    } else {
      const { data: existingWallet } = await admin
        .from("wallets")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();

      if (!existingWallet) {
        const { error: walletErr } = await admin.from("wallets").insert({
          user_id: userId,
          address: primaryWallet.address,
          circle_wallet_id: primaryWallet.id,
          usdc_balance: 0,
          wallet_type: "ucw",
        });
        if (walletErr) {
          // Don't fail the login, but never swallow it — an unchecked insert here
          // silently leaves the user wallet-less while login still "succeeds".
          console.error("unified: wallet persist failed", {
            userId,
            address: primaryWallet.address,
            err: walletErr.message,
          });
        }
      }
    }
  }

  // .B2: mark the account provisioned once a real wallet with an address
  // has been persisted.
  if (realWalletStored && !provisioned) {
    await admin.from("users").update({ wallet_provisioned: true }).eq("id", userId);
    provisioned = true;
  }

  // 4. PIN provisioning is evaluated for EVERY real session (the
  //    old `!provisioned` gate skipped legacy accounts that had a wallet but
  //    never set a PIN). The decision covers full / pin-only / wallet-only
  //    challenges via challengeForProvisioningAction. Never blocks login:
  //    every Circle failure is swallowed and logged.
  let pinSetup:
    | { needsPinSetup: true; pinSetupChallengeId: string; pinSetupAction: string }
    | null = null;
  if (!userToken.startsWith("dev-token-")) {
    try {
      const status = await getCircleUserStatus(userToken);
      const decision = decideProvisioning({
        pinStatus: status.pinStatus,
        hasWallet: !!primaryWallet,
      });
      const challenge = await challengeForProvisioningAction(decision, userToken);
      if (challenge) {
        // `pinSetupAction` = what this challenge actually does. For Circle users
        // with authMode EMAIL, pinStatus is ENABLED from creation (Circle
        // provisions the wallet for email sign-ups — see Circle docs
        // "Authentication Types > Email"), so the only challenge ever offered is
        // 'wallet-only-challenge'. Labelling that as "set up your PIN" is wrong.
        pinSetup = {
          needsPinSetup: true,
          pinSetupChallengeId: challenge.challengeId,
          pinSetupAction: decision,
        };
      } else if (decision === "done" && !provisioned) {
        // PIN enabled + wallet exists but the flag was missed (e.g. the
        // completion call failed earlier). The wallet row upsert above
        // already stored it; set the flag here too.
        await admin.from("users").update({ wallet_provisioned: true }).eq("id", userId);
      }
      // decision 'locked'/'skip' → nothing; the restore flow is handled
      // separately.
    } catch (e) {
      console.error("[auth/unified] PIN provisioning check failed (login continues):", e);
    }
  }

  const res = jsonOk({
    user: {
      id: userId,
      uid: publicUid,
      name: displayName,
      handle,
      username,
      email,
      role,
      txCount,
    },
    wallet: primaryWallet
      ? { address: primaryWallet.address, id: primaryWallet.id }
      : null,
    userToken,
    encryptionKey,
    ...(pinSetup ?? {}),
  });

  // Session cookies for middleware + getCurrentUser (must be set here — FE never sets httpOnly cookies).
  return withSessionCookies(req, res, { userToken, email, encryptionKey: encryptionKey || undefined });
}
