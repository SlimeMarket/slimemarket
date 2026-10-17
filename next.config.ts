import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Webhook route needs raw body for signature verification; handled via req.text() in route handler.

  // Optimize package imports to reduce bundle size
  experimental: {
    optimizePackageImports: [
      '@circle-fin/user-controlled-wallets',
      '@rainbow-me/rainbowkit',
      '@tanstack/react-query'
    ],
  },

  // Compress server responses (Next.js v14+ default)
  compress: true,

  // Prevent stale frontend code + security headers
  async headers() {
    return [
      {
        source: "/:path*.jsx",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
      {
        // Security headers applied to all routes
        source: "/(.*)?",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Allow inline scripts (Babel), eval (Next.js), CDN scripts (Recharts, Babel, Lucide)
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://challenges.circle.com https://unpkg.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob: https: http://127.0.0.1:54321 http://localhost:54321",
              // the Arc App Kit onramp widget renders in a cross-origin
              // iframe from onramp.arc.io (sandbox: onramp-sandbox.arc.io).
              // Without these in frame-src the iframe is blocked and fails
              // silently (no console error the user would notice).
              "frame-src https://challenges.circle.com https://*.circle.com https://onramp.arc.io https://onramp-sandbox.arc.io https://*.arc.io",
              // RPC hosts: the browser wallet bridge talks to the SAME chain as
              // the server (selected by ARC_CHAIN_ID via /config.js). Both the
              // mainnet and testnet RPC hosts must be allowed here, otherwise a
              // network switch turns into an opaque "Failed to fetch" inside
              // the wallet instead of a real error.
              "connect-src 'self' https://*.circle.com https://api.arc.io https://*.arc.io wss: https://rpc.mainnet.arc.io https://rpc.testnet.arc.io https://rpc.testnet.arc.network https://cca-lite.coinbase.com",
              "font-src 'self' data: https://fonts.gstatic.com",
              "object-src 'none'",
              "base-uri 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
