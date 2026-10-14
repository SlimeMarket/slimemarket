/**
 * AppKitBridge — browser surface for Circle Arc App Kit .
 *
 * WHY A SEPARATE BUNDLE: the public/ SPA is browser-transpiled Babel and cannot
 * `import` npm packages. Like `wallet-bridge/entry.tsx`, this file is bundled by
 * esbuild into a self-contained IIFE (`public/app-kit-bridge.js`) that exposes a
 * vanilla `window.AppKitBridge` API.
 *
 * We import the STANDALONE kits (onramp/bridge/swap) rather than the aggregate
 * `@circle-fin/app-kit`, because the aggregate also pulls in Earn, Unified
 * Balance and the Solana stack — none of which the browser needs here, and all
 * of which would bloat the CDN payload.
 *
 * Build: see the `build:app-kit-bridge` npm script.
 */
import { BridgeKit, BridgeChain } from "@circle-fin/bridge-kit";
import { SwapKit, SwapChain } from "@circle-fin/swap-kit";
import { createOnrampKit, fetchOnrampSession } from "@circle-fin/onramp-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";

type Json = Record<string, unknown>;

/** Structured failure so the SPA can show an honest message instead of a stack. */
export interface KitFailure {
  ok: false;
  code: string;
  message: string;
}

export interface KitSuccess<T = Json> {
  ok: true;
  data: T;
}

type KitResult<T = Json> = KitSuccess<T> | KitFailure;

function fail(e: unknown): KitFailure {
  const err = e as { code?: unknown; name?: unknown; message?: unknown };
  return {
    ok: false,
    code: typeof err?.code === "string" ? err.code : "UNKNOWN",
    message:
      typeof err?.message === "string" && err.message
        ? err.message
        : "App Kit operation failed",
  };
}

/** The widget origin, injected by the server via /config.js so both sides agree. */
function widgetBaseUrl(): string | undefined {
  const cfg = (window as unknown as { SLIME_CONFIG?: { appKitWidgetUrl?: string } })
    .SLIME_CONFIG;
  return cfg?.appKitWidgetUrl || undefined;
}

/** EIP-1193 provider the user's external wallet is connected through. */
function eip1193(): unknown {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) {
    throw Object.assign(new Error("No EVM wallet detected — connect MetaMask first"), {
      code: "NO_PROVIDER",
    });
  }
  return eth;
}

// ── Onramp ───────────────────────────────────────────────────────────

let onrampWidget: { close(): void } | null = null;

export interface MountOnrampOptions {
  /** Element id that receives the iframe. Must have an explicit non-zero height. */
  containerId: string;
  onSettled?: (payload: unknown) => void;
  onNotCompleted?: (code: string) => void;
  onReady?: () => void;
}

export interface AppKitBridgeAPI {
  /** True when the bundle loaded and the browser has a wallet provider. */
  isAvailable(): boolean;
  /** Environment the widget is pointed at (sandbox vs production). */
  environment(): "sandbox" | "production";

  mountOnramp(options: MountOnrampOptions): Promise<KitResult>;
  closeOnramp(): void;

  bridge(params: {
    fromChain: string;
    toChain: string;
    recipientAddress: string;
    amount: string;
    token?: string;
    /**
     * CCTP transfer speed.
     *
     * The SDK defaults this to `FAST`, but not every source chain supports Fast
     * Transfer — Avalanche, Polygon PoS, Sei, XDC and their testnets are
     * Standard-Transfer-only. Asking for FAST there fails with a Quote API error
     * (`PRE_FINALITY_UNAVAILABLE`, surfaced as HTTP 422).
     *
     * Pass "SLOW" for those chains. Omit it elsewhere so FAST stays the default.
     */
    transferSpeed?: "FAST" | "SLOW";
  }): Promise<KitResult>;

  swap(params: {
    chain: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    toChain?: string;
    recipientAddress?: string;
  }): Promise<KitResult>;

  supportedChains(): { bridge: string[]; swap: string[] };
}

const AppKitBridge: AppKitBridgeAPI = {
  isAvailable() {
    return typeof window !== "undefined";
  },

  environment() {
    const url = widgetBaseUrl() ?? "";
    return url.includes("sandbox") ? "sandbox" : "production";
  },

  async mountOnramp({ containerId, onSettled, onNotCompleted, onReady }) {
    try {
      const container = document.getElementById(containerId);
      if (!container) {
        throw Object.assign(new Error(`container #${containerId} not found`), {
          code: "NO_CONTAINER",
        });
      }
      if (!container.clientHeight) {
        // The iframe fills its container; a zero-height container collapses it
        // to 0px and the widget silently looks broken.
        throw Object.assign(
          new Error(`container #${containerId} has zero height — give it an explicit height`),
          { code: "CONTAINER_NO_HEIGHT" },
        );
      }

      // Mint the session on our server (which holds the API key) and only ever
      // receive the short-lived token here.
      const session = await fetchOnrampSession({
        url: "/api/wallet/onramp/session",
        body: {},
      });

      const kit = createOnrampKit({ widgetBaseUrl: widgetBaseUrl() });
      onrampWidget = kit.mountIframe({
        session,
        container,
        onInitializationSuccess: () => onReady?.(),
        onDepositSettled: (e: unknown) => onSettled?.(e),
        onDepositNotCompleted: (e: { code?: string } | undefined) =>
          onNotCompleted?.(e?.code ?? "UNKNOWN"),
      } as never);

      return { ok: true, data: { environment: AppKitBridge.environment() } };
    } catch (e) {
      return fail(e);
    }
  },

  closeOnramp() {
    try {
      onrampWidget?.close();
    } catch {
      /* already closed */
    }
    onrampWidget = null;
  },

  async bridge({ fromChain, toChain, recipientAddress, amount, token, transferSpeed }) {
    try {
      const adapter = await createViemAdapterFromProvider({ provider: eip1193() as never });
      const kit = new BridgeKit();
      const result = await kit.bridge({
        from: { adapter, chain: fromChain as BridgeChain },
        to: { chain: toChain as BridgeChain, recipientAddress },
        amount,
        ...(token ? { token } : {}),
        // Only sent when the caller asks for it — omitting keeps the SDK default
        // (FAST), which is what every Fast-capable chain wants.
        ...(transferSpeed ? { config: { transferSpeed } } : {}),
      } as never);
      return { ok: true, data: result as unknown as Json };
    } catch (e) {
      return fail(e);
    }
  },

  async swap({ chain, tokenIn, tokenOut, amountIn, toChain, recipientAddress }) {
    try {
      const adapter = await createViemAdapterFromProvider({ provider: eip1193() as never });
      const kit = new SwapKit();
      const result = await kit.swap({
        from: { adapter, chain: chain as SwapChain },
        tokenIn,
        tokenOut,
        amountIn,
        ...(toChain ? { to: { chain: toChain, recipientAddress } } : {}),
      } as never);
      return { ok: true, data: result as unknown as Json };
    } catch (e) {
      return fail(e);
    }
  },

  supportedChains() {
    try {
      const bridge = new BridgeKit()
        .getSupportedChains({ isTestnet: true })
        .map((c) => c.name);
      const swap = new SwapKit()
        .getSupportedChains()
        .filter((c) => c.isTestnet)
        .map((c) => c.name);
      return { bridge, swap };
    } catch {
      return { bridge: [], swap: [] };
    }
  },
};

(window as unknown as { AppKitBridge: AppKitBridgeAPI }).AppKitBridge = AppKitBridge;
