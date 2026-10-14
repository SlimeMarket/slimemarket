import { getCurrentUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { initiateWithdraw } from "@/lib/wallet/withdraw";
import { initiateCryptoWithdraw } from "@/lib/wallet/crypto-withdraw";
import { preflightCryptoWithdraw, initiateUcwSendChallenge } from "@/lib/wallet/ucw-send";
import { decideSendPath } from "@/lib/wallet/send-mode";
import { shouldMockChallenge } from "@/lib/wallet/challenge-gate";
import { getCircleUserStatus } from "@/lib/circle/ucw-user";
import { checkUserRateLimit, WITHDRAW_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, WithdrawBodySchema } from "@/lib/schemas";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  // Per-user rate limit on withdraw (stricter)
  const rlErr = await checkUserRateLimit(user.id, "withdraw", WITHDRAW_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON body", 400); }

  // Validate body. WithdrawBodySchema enforces exactly one of bankAccountId /
  // destAddress set + amountUsdc is a positive decimal string + destAddress is
  // a valid 0x... hex (not arbitrary input that feeds on-chain calls).
  const parsed = parseBody(WithdrawBodySchema, body);
  if (parsed instanceof Response) return parsed;

  if (parsed.destAddress) {
    // mode selection: real sessions with an enabled PIN send via a
    // UCW TRANSFER challenge (funds leave the USER's own wallet, signed with
    // their PIN on their device — email compromise alone can't drain funds).
    // Dev/mock sessions keep the legacy platform-DCW reimburse path.
    const creds = await getUcwCredentials();
    const mock =
      !creds || !creds.circleWalletId
        ? true
        : shouldMockChallenge({ userToken: creds.userToken, circleWalletId: creds.circleWalletId });

    let pinStatus = "ENABLED"; // only consulted when !mock
    if (!mock) {
      try {
        const status = await getCircleUserStatus(creds!.userToken);
        pinStatus = status.pinStatus;
      } catch (e) {
        console.error("[withdraw] pinStatus lookup failed:", e);
        // Fail-open for the lookup itself: if Circle is down, fall through to
        // the UCW path and let the challenge creation surface the real error.
        pinStatus = "ENABLED";
      }
    }

    const decision = decideSendPath({ shouldMock: mock, pinStatus });
    if (decision.mode === "blocked") {
      return jsonError(
        decision.code === "PIN_SETUP_REQUIRED"
          ? "Set up your wallet PIN before sending funds"
          : "Your wallet PIN is locked — try again later or restore it",
        decision.httpStatus,
        { code: decision.code },
      );
    }

    if (decision.mode === "ucw-challenge") {
      try {
        const pf = await preflightCryptoWithdraw({
          user, destAddress: parsed.destAddress, amountUsdc: parsed.amountUsdc,
        });
        const result = await initiateUcwSendChallenge({
          user,
          dest: pf.dest,
          amountMicro: pf.amountMicro,
          walletId: pf.walletId,
          circleWalletId: creds!.circleWalletId!,
          userToken: creds!.userToken,
        });
        // FE runs executeUcwChallenge(challengeId) → Circle PIN prompt → then
        // POST /api/wallet/withdraw/ucw-settle with the on-chain txHash.
        return jsonOk({
          mode: "ucw-challenge",
          challengeId: result.challengeId,
          walletTxId: result.walletTxId,
          destAddress: pf.dest,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "crypto withdraw failed";
        return jsonError(msg, /blocklisted|invalid/i.test(msg) ? 422 : 400);
      }
    }

    // Legacy path (dev/mock sessions — Playwright automation unaffected).
    try {
      const result = await initiateCryptoWithdraw({
        user,
        destAddress: parsed.destAddress,
        amountUsdc: parsed.amountUsdc,
      });
      return jsonOk(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "crypto withdraw failed";
      return jsonError(msg, /blocklisted|invalid/i.test(msg) ? 422 : 400);
    }
  }

  // bankAccountId is set (guaranteed by schema refine).
  const result = await initiateWithdraw({
    user,
    bankAccountId: parsed.bankAccountId!,
    amountUsdc: parsed.amountUsdc,
  });
  return jsonOk(result);
}
