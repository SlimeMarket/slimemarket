/**
 * .B — client bootstrap config served as JS so the public/ SPA gets the
 * REAL Turnstile site key + Circle app id from the SERVER env, instead of the
 * empty hardcoded placeholder that used to live inline in index.html.
 *
 * Why not inline in index.html: public/ is static and cannot read process.env.
 * The catch-all route COULD inject, but public/index.html shadows `/`, so an
 * explicit same-origin script is the reliable path. Next.js exposes the
 * NEXT_PUBLIC_* var at build time too, but this route is force-dynamic so the
 * value is read at request time — works when the env is only present in the
 * runtime environment (Vercel project settings / VPS .env) without a rebuild.
 *
 * Served with no-store: config must reflect the current deployment env.
 */
import { onrampWidgetBaseUrl, appKitEnv } from "@/lib/circle/app-kit";
import { ARC_CHAIN_ID, ARC_EXPLORER_URL, ARC_RPC_URL, ARC_USDC_CONTRACT, IS_ARC_MAINNET } from "@/lib/arc";

export const dynamic = "force-dynamic";

export async function GET() {
  // DEPLOY BLOCKER. This read `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
  // only, while `.env.example` told the operator to set
  // `TURNSTILE_SITE_KEY`. So the site key arrived as "" even when it WAS set:
  //   config.js → window.SLIME_CONFIG.turnstileSiteKey = ""
  //     → public/index.html: window.TURNSTILE_SITE_KEY = ""
  //       → public/auth.jsx: the widget is never rendered (`{TURNSTILE_SITE_KEY && …}`)
  //         → no turnstileToken is ever sent
  //           → /api/auth/email-otp `requireTurnstile` returns 403 in production
  //             → NOBODY CAN REQUEST AN OTP → NOBODY CAN SIGN UP OR LOG IN.
  // Invisible in dev because `requireTurnstile` skips verification when
  // NODE_ENV !== "production". Accept both names so either spelling works.
  // 2026-09-27 — Turnstile is DISABLED by default (opt-in via TURNSTILE_ENABLED).
  // An EMPTY site key is what makes the browser skip the widget entirely
  // (public/auth.jsx renders it only when the key is non-empty), so this single
  // switch turns the whole Turnstile flow off/on for FE and BE together.
  const turnstileSiteKey =
    process.env.TURNSTILE_ENABLED === "true"
      ? process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || process.env.TURNSTILE_SITE_KEY || ""
      : "";

  const config = {
    turnstileSiteKey,
    circleAppId: process.env.CIRCLE_APP_ID || "",
    // Onramp widget origin. Server and browser MUST agree, or the kit
    // throws INPUT_WIDGET_URL_ORIGIN_MISMATCH (1910). Serving it from here means
    // APP_KIT_ENV alone decides sandbox vs production on both sides.
    appKitWidgetUrl: onrampWidgetBaseUrl(),
    appKitEnv: appKitEnv(),
    // Chain the browser wallet must be on (wallet-bridge reads this).
    // The bridge bundle is a STATIC file under public/, so it cannot read
    // process.env — it used to hardcode Arc Testnet (5042002) + the
    // rpc.testnet.arc.network host, which is dead. That made every
    // external-wallet checkout fail with "User rejected the request" while
    // the server was already on mainnet. Serving the chain here keeps the
    // browser and server on the same network with no rebuild.
    chain: {
      id: ARC_CHAIN_ID,
      name: IS_ARC_MAINNET ? "Arc" : "Arc Testnet",
      rpcUrl: ARC_RPC_URL,
      explorerUrl: ARC_EXPLORER_URL,
      nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
    },
    usdcAddress: ARC_USDC_CONTRACT,
  };
  // JSON inside a JS wrapper (not a bare object literal) so the values are
  // valid JS regardless of what env strings contain.
  const body = `window.SLIME_CONFIG = ${JSON.stringify(config)};`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
