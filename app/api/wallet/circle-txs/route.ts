import { getCurrentUser, getUcwCredentials, isDevTokenSession } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { checkUserRateLimit, FINANCIAL_RATE_LIMIT } from "@/lib/rate-limit";
import { circleUcwSdk } from "@/lib/circle/ucw-client";
import { mapUcwError, UcwError } from "@/lib/circle/ucw-user";

/**
 * GET /api/wallet/circle-txs — .C2 transaction-history supplement.
 *
 * The /wallet page's Transaction History is ALWAYS populated from the DB
 * first (wallet_txs + order settlement events via /api/wallet recentTx).
 * When that list is empty AND the session is a REAL UCW session (not a
 * dev-login), this endpoint supplements the history directly from Circle's
 * `listTransactions` (ARC-TESTNET only).
 *
 * Dev sessions are skipped (mock wallets have no Circle-side history).
 *
 * Response items are mapped to the FE row shape used by balance.jsx:
 * `{ id, type: 'in'|'out', label, sub, amount, status, time, txHash,
 *    source: 'circle' }` — amounts are plain USDC decimals (no rupiah).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  if (await isDevTokenSession()) {
    // Mock session — nothing on Circle's side to supplement.
    return jsonOk({ txs: [], devMode: true });
  }

  const rlErr = await checkUserRateLimit(user.id, "wallet-circle-txs", FINANCIAL_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  if (!circleUcwSdk) return jsonOk({ txs: [], error: "ucw not configured" });

  const creds = await getUcwCredentials();
  if (!creds) {
    return jsonError(
      "UCW credentials missing — refresh your wallet session (redirect to /refresh-session)",
      401,
    );
  }

  try {
    const res = await circleUcwSdk.listTransactions({
      userToken: creds.userToken,
      blockchain: "ARC-TESTNET",
      pageSize: 20,
    });
    const list = res.data?.transactions ?? [];
    const walletId = creds.circleWalletId;

    const txs = list.map((t) => {
      const usd = parseFloat(t.amountInUSD || "");
      const amountsSum = (t.amounts || []).reduce(
        (s: number, a) => s + (parseFloat(a) || 0),
        0,
      );
      const amount = Number.isFinite(usd) && usd > 0 ? usd : amountsSum;

      // Direction heuristic: compare sourceAddress vs destinationAddress
      // against the user's wallet address. The old heuristic (walletId match
      // + presence of destinationAddress) was buggy — for inbound transfers,
      // the user's wallet IS the destination, so it incorrectly labeled them "out".
      let type: "in" | "out" = "in";
      const me = user.walletAddress?.toLowerCase();
      if (me) {
        const src = t.sourceAddress?.toLowerCase();
        const dst = t.destinationAddress?.toLowerCase();
        if (src === me && dst !== me) {
          type = "out"; // I am the sender
        } else if (dst === me && src !== me) {
          type = "in";  // I am the recipient
        }
        // else: ambiguous / self-transfer → default "in"
      } else if (t.walletId && walletId) {
        // Fallback: only label "out" if walletId matches AND there's a destinationAddress
        // that is NOT the user's own address
        type = t.walletId === walletId && t.destinationAddress ? "out" : "in";
      }

      const op = t.operation ? String(t.operation).toLowerCase() : "transfer";
      return {
        id: `circle-${t.id}`,
        type,
        label: type === "in" ? "Incoming transfer" : "Outgoing transfer",
        sub: `Circle · ${op}`,
        amount: Number.isFinite(amount) ? amount : 0,
        status: String(t.state || "UNKNOWN").toLowerCase(),
        time: new Date(t.createDate || Date.now()).toLocaleString("id-ID", {
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "short",
        }),
        txHash: t.txHash || null,
        source: "circle",
      };
    });

    return jsonOk({ txs });
  } catch (e) {
    if (e instanceof UcwError) return jsonError(e.message, e.httpStatus ?? 502);
    const mapped = mapUcwError(e);
    return jsonError(mapped.message, mapped.httpStatus ?? 502);
  }
}
