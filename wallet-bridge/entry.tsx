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
import { WagmiProvider, createConfig, http, useAccount, useConnect, useDisconnect, useSignMessage, useSignTypedData, useSendTransaction, useChainId } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { base, avalanche } from "wagmi/chains";
import { injected, coinbaseWallet } from "wagmi/connectors";
import { RainbowKitProvider, ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";

// ── Arc Testnet custom chain ──────────────────────────────────────────
const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
  },
} as const;

// ── Wagmi config (FREE connectors — no WalletConnect projectId) ──────
const config = createConfig({
  chains: [arcTestnet, base, avalanche],
  connectors: [
    injected(),
    coinbaseWallet({ appName: "SlimeMarket" }),
  ],
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
    [base.id]: http(),
    [avalanche.id]: http(),
  },
});

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
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { sendTransactionAsync } = useSendTransaction();

  // Sync state to module-level + emit events
  useEffect(() => {
    const addr = address ?? null;
    if (addr !== currentAddress) emitChange(addr);
    currentChainId = chainId ?? null;
  }, [address, chainId]);

  // Expose imperative APIs on window globals (consumed by window.WalletBridge)
  useEffect(() => {
    (window as any).__wb = {
      openModal: openConnectModal,
      disconnect: () => disconnect(),
      signMessage: async (message: string) => {
        const sig = await signMessageAsync({ message });
        return sig;
      },
      signTypedData: async (domain: any, types: any, message: any, primaryType?: string) => {
        // wagmi v3 signTypedData takes the connected account automatically.
        // `types` must NOT include EIP712Domain (wagmi derives it from domain).
        const sig = await signTypedDataAsync({ domain, types, primaryType: primaryType ?? "Permit", message } as any);
        return sig;
      },
      sendTransaction: async (tx: { to: string; data?: string; value?: bigint }) => {
        const hash = await sendTransactionAsync(tx as any);
        return hash;
      },
    };
    return () => { delete (window as any).__wb; };
  }, [openConnectModal, disconnect, signMessageAsync, signTypedDataAsync, sendTransactionAsync]);

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
        if (currentAddress) { clearInterval(check); resolve(currentAddress); }
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
  async signMessage(message: string) {
    const wb = (window as any).__wb;
    if (!wb?.signMessage) throw new Error("Wallet bridge not ready");
    return wb.signMessage(message);
  },
  async signTypedData(domain: any, types: any, message: any, primaryType?: string) {
    const wb = (window as any).__wb;
    if (!wb?.signTypedData) throw new Error("Wallet bridge not ready");
    if (!currentAddress) throw new Error("Wallet not connected — call WalletBridge.connect() first");
    if (currentChainId !== null && currentChainId !== arcTestnet.id) {
      throw new Error(`Wallet is on chain ${currentChainId} — switch to Arc Testnet (${arcTestnet.id}) first`);
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
