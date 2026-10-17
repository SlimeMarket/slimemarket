/**
 * WalletBridge — Self-contained RainbowKit + wagmi bridge for the CDN frontend.
 *
 * Bundled as an IIFE via esbuild. Creates its own React 19 root (isolated from
 * the CDN app's React 18 UMD). Exposes `window.WalletBridge` vanilla JS API.
 *
 * Build:
 *   npx esbuild wallet-bridge/entry.tsx --bundle --outfile=public/wallet-bridge.js \
 *     --format=iife --jsx=automatic --define:process.env.NODE_ENV='"production"' --minify
 */
import React, { useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider, createConfig, http, useAccount, useConnect, useDisconnect, useSignMessage, useSignTypedData, useSendTransaction, useChainId, useSwitchChain } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { base, avalanche } from "wagmi/chains";
import { injected, coinbaseWallet } from "wagmi/connectors";
import type { Chain } from "viem";
import { RainbowKitProvider, ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";

// ── Arc chain: resolved at RUNTIME from /config.js ───────────────────
//
// This used to be a hardcoded `arcTestnet` (5042002) with the RPC
// https://rpc.testnet.arc.network — baked into the bundle. The app went
// mainnet, the bundle did not, so every external-wallet checkout asked the
// wallet to send on Arc TESTNET against a host that no longer answers:
//
//   Request Arguments: chain: Arc Testnet (id: 5042002)
//   HTTP request failed. URL: https://rpc.testnet.arc.network/
//   {"method":"eth_getTransactionCount",...} → Failed to fetch
//
// ...which surfaces to the user as "User rejected the request" (the wallet
// could not even build the tx, so it reports a rejection). The bundle is a
// static file under public/, so a hardcoded network means every network
// change needs a rebuild + redeploy. /config.js is served by Next from the
// server env, so reading it here makes the network follow ARC_CHAIN_ID.
type ChainConfig = {
  id: number;
  name: string;
  rpcUrl: string;
  explorerUrl?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

// Fallback must match PRODUCTION (mainnet). Never fall back to a testnet:
// a silent testnet fallback is exactly the failure this fix removes.
const FALLBACK_CHAIN: ChainConfig = {
  id: 5042,
  name: "Arc",
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorerUrl: "https://arc.etherscan.io",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
};

function resolveChain(): ChainConfig {
  const raw = (window as any).SLIME_CONFIG?.chain;
  const id = Number(raw?.id);
  const rpcUrl = typeof raw?.rpcUrl === "string" ? raw.rpcUrl.trim() : "";
  if (!Number.isFinite(id) || id <= 0 || !/^https?:\/\//i.test(rpcUrl)) {
    if (raw) {
      console.error(
        "[wallet-bridge] invalid SLIME_CONFIG.chain (need numeric id + http(s) rpcUrl) — using Arc mainnet",
        raw,
      );
    }
    return FALLBACK_CHAIN;
  }
  const nc = raw?.nativeCurrency;
  return {
    id,
    name: typeof raw?.name === "string" && raw.name ? raw.name : `Chain ${id}`,
    rpcUrl,
    explorerUrl:
      typeof raw?.explorerUrl === "string" && raw.explorerUrl ? raw.explorerUrl : undefined,
    nativeCurrency:
      nc && typeof nc.symbol === "string"
        ? {
            name: nc.name || "USD Coin",
            symbol: nc.symbol,
            decimals: Number.isFinite(Number(nc.decimals)) ? Number(nc.decimals) : 6,
          }
        : { name: "USD Coin", symbol: "USDC", decimals: 6 },
  };
}

const ARC = resolveChain();

const arcChain = {
  id: ARC.id,
  name: ARC.name,
  nativeCurrency: ARC.nativeCurrency,
  rpcUrls: { default: { http: [ARC.rpcUrl] } },
  ...(ARC.explorerUrl
    ? { blockExplorers: { default: { name: "Explorer", url: ARC.explorerUrl } } }
    : {}),
} as unknown as Chain;

/** EIP-3085 payload used to add the chain when the wallet doesn't know it. */
const ADD_CHAIN_PARAMS = {
  chainId: "0x" + ARC.id.toString(16),
  chainName: ARC.name,
  nativeCurrency: ARC.nativeCurrency,
  rpcUrls: [ARC.rpcUrl],
  ...(ARC.explorerUrl ? { blockExplorerUrls: [ARC.explorerUrl] } : {}),
};

// ── Wagmi config (FREE connectors — no WalletConnect projectId) ──────
const config = createConfig({
  chains: [arcChain, base, avalanche] as const,
  connectors: [
    injected(),
    coinbaseWallet({ appName: "SlimeMarket" }),
  ],
  transports: {
    [ARC.id]: http(ARC.rpcUrl),
    [base.id]: http(),
    [avalanche.id]: http(),
  },
} as any);

const queryClient = new QueryClient();

// ── Bridge state (module-level, shared with window.WalletBridge) ─────
type Listener = (address: string | null) => void;
const listeners: Listener[] = [];
let currentAddress: string | null = null;
let currentChainId: number | null = null;

function emitChange(address: string | null) {
  currentAddress = address;
  for (const cb of listeners) {
    try { cb(address); } catch { /* listener error */ }
  }
}

// ── Inner app (has access to wagmi hooks) ────────────────────────────
function BridgeInner() {
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { sendTransactionAsync } = useSendTransaction();

  // Sync state to module-level + emit events
  useEffect(() => {
    const addr = address ?? null;
    if (addr !== currentAddress) emitChange(addr);
    currentChainId = chainId ?? null;
  }, [address, chainId]);

  // ── Ensure the wallet is on the configured Arc network ──────────────
  // Without this, a wallet sitting on Arc Testnet (or anything else) makes
  // viem call the wrong RPC, which the wallet reports as "User rejected".
  const ensureChain = useCallback(async () => {
    if (chainId === ARC.id) return;
    try {
      await switchChainAsync({ chainId: ARC.id });
      return;
    } catch (err) {
      const code = (err as any)?.code ?? (err as any)?.cause?.code;
      const msg = String((err as any)?.shortMessage ?? (err as any)?.message ?? err);
      // 4902 = chain not added to the wallet. Anything else (4001 = user
      // rejected) must bubble up so the UI can say what actually happened.
      const notAdded = code === 4902 || /unrecognized chain|try adding the chain|not added/i.test(msg);
      if (!notAdded) throw err;
    }
    const provider: any = await (connector as any)?.getProvider?.();
    if (!provider?.request) {
      throw new Error(
        `Wallet does not know ${ARC.name} (${ARC.id}) and cannot add it automatically. ` +
          `Add it manually — RPC ${ARC.rpcUrl}, chain id ${ARC.id}.`,
      );
    }
    await provider.request({ method: "wallet_addEthereumChain", params: [ADD_CHAIN_PARAMS] });
    await switchChainAsync({ chainId: ARC.id });
  }, [chainId, connector, switchChainAsync]);

  // Expose imperative APIs on window globals (consumed by window.WalletBridge)
  useEffect(() => {
    (window as any).__wb = {
      openModal: openConnectModal,
      disconnect: () => disconnect(),
      ensureChain,
      chain: ARC,
      signMessage: async (message: string) => {
        await ensureChain();
        const sig = await signMessageAsync({ message });
        return sig;
      },
      signTypedData: async (domain: any, types: any, message: any, primaryType?: string) => {
        // wagmi v3 signTypedData takes the connected account automatically.
        // `types` must NOT include EIP712Domain (wagmi derives it from domain).
        await ensureChain();
        const sig = await signTypedDataAsync({ domain, types, primaryType: primaryType ?? "Permit", message } as any);
        return sig;
      },
      sendTransaction: async (tx: { to: string; data?: string; value?: bigint }) => {
        await ensureChain();
        const hash = await sendTransactionAsync(tx as any);
        return hash;
      },
    };
    return () => { delete (window as any).__wb; };
  }, [openConnectModal, disconnect, ensureChain, signMessageAsync, signTypedDataAsync, sendTransactionAsync]);

  // Render RainbowKit ConnectButton (hidden — used for its modal)
  return (
    <div style={{ display: "none" }}>
      <ConnectButton />
    </div>
  );
}

// ── Provider wrapper ─────────────────────────────────────────────────
function WalletBridgeApp() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider appInfo={{ appName: "SlimeMarket" }}>
          <BridgeInner />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

// ── Public API: window.WalletBridge ──────────────────────────────────
export interface WalletBridgeAPI {
  connect(): Promise<string | null>;
  disconnect(): void;
  getAddress(): string | null;
  getChainId(): number | null;
  isConnected(): boolean;
  /** Chain the bridge targets (from /config.js) — id, name, RPC, explorer. */
  getChain(): ChainConfig;
  /** Switch the wallet to the configured Arc chain, adding it if unknown. */
  ensureChain(): Promise<void>;
  signMessage(message: string): Promise<string>;
  /**
   * EIP-712 typed-data signature (e.g. EIP-2612 permit). `types` must NOT
   * include EIP712Domain (derived from `domain` by wagmi/viem). Returns the
   * 65-byte signature hex (r ‖ s ‖ v).
   */
  signTypedData(domain: any, types: any, message: any, primaryType?: string): Promise<string>;
  sendTransaction(tx: { to: string; data?: string; value?: bigint }): Promise<string>;
  onAccountsChanged(cb: Listener): () => void;
}

const WalletBridge: WalletBridgeAPI = {
  connect() {
    return new Promise((resolve) => {
      // If already connected, resolve immediately
      if (currentAddress) { resolve(currentAddress); return; }
      // Open RainbowKit modal
      const wb = (window as any).__wb;
      if (wb?.openModal) wb.openModal();
      // Wait for connection (poll — RainbowKit modal is async)
      const check = setInterval(() => {
        if (currentAddress) {
          clearInterval(check);
          // Best-effort: move the freshly connected wallet onto the app's
          // chain right away. A wallet still on Arc Testnet would otherwise
          // fail later with "User rejected the request" at signing time.
          Promise.resolve((window as any).__wb?.ensureChain?.())
            .catch((e: any) => console.warn("[wallet-bridge] chain switch skipped:", e?.message ?? e))
            .finally(() => resolve(currentAddress));
        }
      }, 200);
      // Timeout after 120s (user might take a while)
      setTimeout(() => { clearInterval(check); resolve(currentAddress); }, 120_000);
    });
  },
  disconnect() {
    (window as any).__wb?.disconnect();
    emitChange(null);
  },
  getAddress: () => currentAddress,
  getChainId: () => currentChainId,
  isConnected: () => !!currentAddress,
  getChain: () => ARC,
  async ensureChain() {
    const wb = (window as any).__wb;
    if (!wb?.ensureChain) throw new Error("Wallet bridge not ready");
    if (!currentAddress) throw new Error("Wallet not connected — call WalletBridge.connect() first");
    await wb.ensureChain();
  },
  async signMessage(message: string) {
    const wb = (window as any).__wb;
    if (!wb?.signMessage) throw new Error("Wallet bridge not ready");
    return wb.signMessage(message);
  },
  async signTypedData(domain: any, types: any, message: any, primaryType?: string) {
    const wb = (window as any).__wb;
    if (!wb?.signTypedData) throw new Error("Wallet bridge not ready");
    if (!currentAddress) throw new Error("Wallet not connected — call WalletBridge.connect() first");
    if (currentChainId !== null && currentChainId !== ARC.id) {
      throw new Error(`Wallet is on chain ${currentChainId} — switch to ${ARC.name} (${ARC.id}) first`);
    }
    return wb.signTypedData(domain, types, message, primaryType);
  },
  async sendTransaction(tx) {
    const wb = (window as any).__wb;
    if (!wb?.sendTransaction) throw new Error("Wallet bridge not ready");
    return wb.sendTransaction(tx);
  },
  onAccountsChanged(cb: Listener) {
    listeners.push(cb);
    return () => {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  },
};

(window as any).WalletBridge = WalletBridge;
// Build stamp — lets anyone confirm in the console which bundle the tab is
// actually running (`window.__SLIME_WB_BUILD`). Without it, a stale cached
// bundle is indistinguishable from a broken fix.
(window as any).__SLIME_WB_BUILD = "20261017b";

// ── Mount (wait for DOM ready — script may load in <head>) ──────────
function mount() {
  const container = document.createElement("div");
  container.id = "wallet-bridge-root";
  container.style.display = "contents";
  document.body.appendChild(container);

  const root = createRoot(container);
  root.render(<WalletBridgeApp />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
