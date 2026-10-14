# syntax=docker/dockerfile:1
#
# SlimeMarket — production image (Next.js 15, Node 22).
#
# Runs TWO commands from the SAME image:
#   web       : npm start            (docker-compose service `web`)
#   scheduler : node scripts/scheduler.js  (service `scheduler`)
# Keeping one image avoids a second dependency tree; the scheduler needs
# node-cron which is a runtime dependency, so it is present either way.
#
# IMPORTANT — build args:
#   NEXT_PUBLIC_* values are INLINED into the client bundle at build time, so
#   they must be supplied when the image is built. They are PUBLIC by design
#   (they ship to the browser), so passing them as build args leaks nothing.
#   Every secret (CIRCLE_API_KEY, SUPABASE service key, SMTP, …) is read at
#   RUNTIME only — never bake those into the image; pass them via env_file.
#
# Build (compose does this automatically):
#   docker build \
#     --build-arg NEXT_PUBLIC_APP_URL=https://domainmu.com \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
#     ... -t slimemarket:latest .

# ---------- deps: full install (build needs devDeps: esbuild, typescript) ----------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
# .npmrc MUST come along: it carries `legacy-peer-deps=true`, which this
# dependency tree needs (see the file for why). Without it `npm ci` re-validates
# peers, hits ERESOLVE on rainbowkit-vs-wagmi, and the image cannot be built.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# ---------- builder ----------
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_CIRCLE_APP_ID
ARG NEXT_PUBLIC_CIRCLE_BASE_URL
ARG NEXT_PUBLIC_AGENT_WALLET_ADDRESS
ARG NEXT_PUBLIC_AGENT_WALLET_ID
ARG NEXT_PUBLIC_USDC_CONTRACT_ADDRESS
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_CIRCLE_APP_ID=$NEXT_PUBLIC_CIRCLE_APP_ID \
    NEXT_PUBLIC_CIRCLE_BASE_URL=$NEXT_PUBLIC_CIRCLE_BASE_URL \
    NEXT_PUBLIC_AGENT_WALLET_ADDRESS=$NEXT_PUBLIC_AGENT_WALLET_ADDRESS \
    NEXT_PUBLIC_AGENT_WALLET_ID=$NEXT_PUBLIC_AGENT_WALLET_ID \
    NEXT_PUBLIC_USDC_CONTRACT_ADDRESS=$NEXT_PUBLIC_USDC_CONTRACT_ADDRESS \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_TELEMETRY_DISABLED=1

# Runs prebuild (clean) → build:wallet-bridge → build:app-kit-bridge → next build
RUN npm run build

# ---------- runner ----------
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat curl
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# Full node_modules (not --omit=dev): `next start` loads next.config.ts at boot
# and the scheduler needs node-cron. Reliability > image size here.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/contracts ./contracts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/instrumentation.ts ./instrumentation.ts
COPY --from=builder /app/middleware.ts ./middleware.ts

EXPOSE 3000

# /api/health returns 503 while merely DEGRADED (indexer not yet run) — that is
# still "alive", so accept 200 AND 503 as healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit([200,503].includes(r.status)?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
