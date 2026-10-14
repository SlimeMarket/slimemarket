import { createAppServerKit, type AppServerKit } from "@circle-fin/app-kit/server";
import { IS_ARC_MAINNET } from "@/lib/arc";
import { logger } from "@/lib/logger";

/**
 * Arc App Kit — server-side singleton .
 *
 * WHY THIS EXISTS: the platform previously had three half-built inbound rails
 * (hand-rolled Gateway SDK, a simulated CCTP stub, and a hand-rolled onramp REST
 * client with no UI caller). Circle now ships one SDK — App Kit — that covers
 * Onramp, Bridge, Swap and Unified Balance behind a single interface, so we
 * adopt it instead of maintaining three divergent integrations.
 *
 * This module owns the SERVER surface only (onramp session minting). The
 * browser surface lives in `app-kit-bridge/entry.ts` → `public/app-kit-bridge.js`
 * and is consumed through `public/app-kit-helper.jsx`.
 *
 * SECURITY: `CIRCLE_API_KEY` must never reach the browser. Only the short-lived
 * session token minted here is safe to hand to the client.
 */

/** Which App Kit environment to talk to. Defaults to production. */
export type AppKitEnv = "sandbox" | "production";

/** Hosted widget origins. Server and client MUST agree (mismatch → error 1910). */
export const ONRAMP_WIDGET_BASE_URL: Record<AppKitEnv, string> = {
  sandbox: "https://onramp-sandbox.arc.io",
  production: "https://onramp.arc.io",
};

/** wallets-api base URLs. API keys are environment-bound — never mix them. */
const ONRAMP_API_BASE_URL: Record<AppKitEnv, string> = {
  sandbox: "https://api-test.circle.com",
  production: "https://api.circle.com",
};

/**
 * Resolve the active App Kit environment.
 *
 * `APP_KIT_ENV=sandbox` is required for local development: the production
 * widget's Content-Security-Policy blocks `localhost`, so a production widget
 * will not load from a dev server. Anything other than an explicit "sandbox"
 * resolves to production, so a typo fails safe toward the real environment.
 */
export function appKitEnv(): AppKitEnv {
  return process.env.APP_KIT_ENV === "sandbox" ? "sandbox" : "production";
}

/** The widget origin the browser must mount for the active environment. */
export function onrampWidgetBaseUrl(): string {
  return ONRAMP_WIDGET_BASE_URL[appKitEnv()];
}

/**
 * Bare hostname of the page that embeds the widget (no scheme/port/path).
 *
 * The widget is rendered inside a cross-origin iframe; the provider authorises
 * our page as a frame ancestor via this value. It is derived from our own
 * trusted config — never from a request header or client input, since a
 * client-supplied value would let a caller widen the allowlist.
 */
export function onrampReferrerDomain(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The onramp environment must match the CHAIN the app settles on.
 *
 * `APP_KIT_ENV` picks which Circle environment the onramp talks to, and each one
 * delivers to a DIFFERENT NETWORK: sandbox → Arc testnet, production → Arc
 * mainnet. The chain is chosen independently, by `ARC_CHAIN_ID`.
 *
 * Nothing links the two, so flipping one and forgetting the other is silent and
 * money-affecting:
 *
 *   • mainnet app + sandbox onramp → real cards are charged, testnet USDC is
 *     delivered, and the escrow can never use it.
 *   • testnet app + production onramp → mainnet USDC is sent to a testnet
 *     address.
 *
 * Both look perfectly healthy until money moves, so assert the pairing instead
 * of trusting whoever runs the deploy to remember. Same shape as
 * `assertArcNetworkConfig()` in lib/arc.
 */
export function assertOnrampMatchesChain(): void {
  const onrampIsSandbox = appKitEnv() === "sandbox";
  const chainIsTestnet = !IS_ARC_MAINNET;
  if (onrampIsSandbox === chainIsTestnet) return;

  throw new Error(
    `onramp/chain mismatch: APP_KIT_ENV="${appKitEnv()}" but the app settles on Arc ` +
      `${IS_ARC_MAINNET ? "MAINNET" : "TESTNET"} (ARC_CHAIN_ID=${process.env.ARC_CHAIN_ID ?? "default"}). ` +
      `Set APP_KIT_ENV=${IS_ARC_MAINNET ? '"production"' : '"sandbox"'} — otherwise the onramp ` +
      `delivers on the wrong network.`,
  );
}

let cached: AppServerKit | null = null;

/**
 * Lazily build (and cache) the server kit.
 *
 * Throws when no API key is configured so a misconfigured deploy fails loudly at
 * the first onramp request instead of silently minting broken sessions.
 *
 * KEY SELECTION: the Circle Console issues a SEPARATE key per product. The
 * App Kit / Onramp key is bound to its own product, so prefer `APP_KIT_API_KEY`
 * and only fall back to the general `CIRCLE_API_KEY` when it is not set (a
 * product-scoped key used against the wrong product is rejected by Circle).
 */
export function appServerKit(): AppServerKit {
  // Checked on EVERY call, not just the first: the assertion is pure, and a
  // warm cache must never be able to hide a network mismatch.
  assertOnrampMatchesChain();

  if (cached) return cached;

  const apiKey = process.env.APP_KIT_API_KEY || process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "APP_KIT_API_KEY (or CIRCLE_API_KEY) is not configured — onramp session minting is unavailable",
    );
  }
  if (!process.env.APP_KIT_API_KEY) {
    // Not fatal — the general key works when it carries App Kit scope (verified:
    // sessions mint with it). But the Console issues a SEPARATE key per product
    // and a product-scoped key used against the wrong product is rejected, so
    // make the fallback visible here instead of discovering it when a user's
    // card fails.
    logger.warn(
      "APP_KIT_API_KEY is not set — falling back to CIRCLE_API_KEY for the onramp. " +
        "Set the dedicated App Kit key from the Circle Console (App Kits).",
    );
  }

  const env = appKitEnv();
  const referrerDomain = onrampReferrerDomain();

  cached = createAppServerKit({
    onramp: {
      apiKey,
      baseUrl: ONRAMP_API_BASE_URL[env],
      widgetBaseUrl: ONRAMP_WIDGET_BASE_URL[env],
      ...(referrerDomain ? { referrerDomain } : {}),
    },
  });

  return cached;
}
