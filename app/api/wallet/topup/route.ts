import { jsonError } from "@/lib/utils";

/**
 * POST /api/wallet/topup — RETIRED .
 *
 * This was the legacy Circle Payments fiat top-up. It is gone for two reasons:
 *
 *   1. It could not work. The real branch POSTed a zero-amount payment to
 *      `api.circle.com/v2/payments` (the USDC amount is only known after the fiat
 *      payment settles), and it was disabled in (`SUPERSEDED_BY_ONRAMP`).
 *      The in-app form kept calling it, so every production top-up attempt failed.
 *
 *   2. Fiat → USDC is now owned by Circle's Arc App Kit Onramp, which mints a
 *      session server-side and delivers USDC straight to the user's wallet on Arc
 *      (`/api/wallet/onramp/session` + the widget mounted by
 *      `public/app-kit-helper.jsx`).
 *
 * The route is kept (rather than deleted) so any stale client gets a clear,
 * actionable 410 instead of a 404.
 */
export async function POST() {
  return jsonError(
    "Fiat top-up via the Circle Payments API has been retired. Use the onramp: open Add funds → Buy with card/bank (POST /api/wallet/onramp/session).",
    410,
    { code: "SUPERSEDED_BY_ONRAMP" },
  );
}

/** GET mirrors POST so a browser hitting the URL also gets the explanation. */
export { POST as GET };
