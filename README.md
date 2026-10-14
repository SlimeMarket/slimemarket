# SlimeMarket — Trustless OTC Escrow on Arc

**A peer-to-peer OTC marketplace where a smart contract replaces the human middleman.**

Today, high-value digital-asset trades — whitelist spots, wallet handovers, mint services,
airdrop-eligible accounts — happen in Telegram DMs and rely on a trusted **human escrow agent**:
someone who holds the money and decides who is right when a deal goes wrong. That person is the
single point of failure, the fee, and the reason these trades stay small.

SlimeMarket moves that flow on-chain. The buyer's funds and the seller's **fraud collateral**
are locked in `MarketEscrow.sol`, settlement is deterministic, and the platform admin acts as
arbitrator only when someone actually disputes. No third party ever holds the money.

Built on **Arc**, Circle's blockchain where **USDC is the native gas token**.

---

## Why Arc

The escrow contract settles in USDC, so the chain had to treat USDC as a first-class citizen:

| Property | Why it matters here |
|---|---|
| **USDC is the native gas token** | No ETH faucet, no second token, no "you need gas to move your money". A user's balance *is* their gas. Critical when your users are Telegram traders, not crypto natives. |
| **Fast, cheap finality** | Escrow runs two clocks (delivery + confirmation). On chains where a tx can sit for minutes, the clock you enforce is not the clock the user experiences. |
| **Circle-native** | User-Controlled Wallets (email OTP login), USDC, and Gateway share one rail — one identity, one balance model. |

The contract itself is chain-agnostic Solidity; these product constraints are why it targets Arc.

---

## What it does

Two escrow flows, one contract:

| Flow | Buyer pays | Seller receives | Platform |
|---|---|---|---|
| **Marketplace order** | `amount + 2%` | `amount − 2%` | 4% |
| **Escrow / OTC deal** | `price + 2%` | `price` (100%) | 2% |

The buyer fee is **non-refundable** and stays collected even on a refund — it pays for the rail.
No base fee, no separate gas charge to the buyer.

### The escrow lifecycle

```
                    ┌─────────────────────────────────────────┐
   WAITING ────────▶│ ESCROW                                  │
 (order placed,     │  buyer funds locked                     │
  nothing held yet) │  seller collateral locked               │
                    └──────┬───────────────────────┬──────────┘
                           │ seller: markDelivered │ either party: flagDispute
                           ▼                       ▼
                     (confirm clock)           DISPUTED ──▶ admin arbitrates:
                           │                                release / refund /
        buyer: confirmEscrow│                               refundEscrowWithSlash
                           ▼                       ▼
                      COMPLETED               COMPLETED / CANCELLED
                       (released)               (refunded)
```

**Two independent clocks, so there is no "whoever calls first wins" race:**

- `deliveryDeadline` — set at **funding**. Miss it and the buyer can force a refund.
- `confirmDeadline` — set when the seller marks delivered. Stay silent past it and the seller
  gets paid.

Both are **per-deal**, chosen by the seller on the listing and clamped to `[1 hour, 365 days]`.
A WL spot ships in minutes; an airdrop-eligible wallet may only pay out months later — a fixed
7-day timeout would be wrong for both.

**Escapes that make funds unstrandable:**

- `releaseEscrowAfterTimeout` / `refundEscrowAfterTimeout` — **permissionless**. Anyone can
  settle once the relevant clock has passed, so a vanished operator cannot freeze a deal.
- **Dispute backstop (30 days)** — if a dispute is never arbitrated, the buyer is the default
  winner. Funds can never be locked forever.
- **Seller collateral** — fraud insurance, in USDC, locked at deal time. On a fraud ruling it is
  **slashed to the buyer** (`refundEscrowWithSlash` pays out `price + collateral`). Without that
  path the collateral would mean nothing.

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| **Runtime** | Node.js 22, Next.js 15 (App Router), React 19 | Route handlers double as the API; one deployable unit. |
| **Frontend** | React 19 SPA in `public/*.jsx`, transpiled in-browser (Babel standalone), Tailwind CSS, Recharts, Lucide | Zero build step for UI edits — ship a screen by saving a file. Served by a catch-all route. |
| **API** | Next.js route handlers (`app/api/**`), Zod-validated bodies | 150+ endpoints: auth, orders, escrow deals, wallet, admin, webhooks. |
| **Database** | Supabase Postgres, 96 migrations, RLS on every table | Postgres for money math (`bigint` micro-USDC, never float) + Row-Level Security as a second line of defence behind the API. |
| **Wallets (users)** | Circle **User-Controlled Wallets** — email OTP login, PIN-signed challenges, MPC key shares | Non-custodial for the user, no seed phrase to lose. Neither we nor the user ever holds a full key. |
| **Wallets (platform)** | Circle **Developer-Controlled Wallets** — treasury, relayer, operator, middleman | Gas sponsorship and relayed settlement so a buyer never needs a second token. |
| **Chain** | **Arc testnet** (chain id `5042002`), USDC as native gas token | A user's balance *is* their gas. |
| **Contract** | Solidity 0.8 + Hardhat + OpenZeppelin — `MarketEscrow.sol` | Escrow, collateral, disputes, timeout escapes. Chain-agnostic; Arc is the deployment target. |
| **Circle rails** | User-Controlled Wallets, Developer-Controlled Wallets, Smart Contract Platform (event monitors), App Kit (Bridge / Swap / Onramp), CCTP | One identity and one balance model across funding, swapping, bridging and settlement. |
| **Email** | Brevo HTTP API + typed transactional templates (order, dispute, invoice, welcome, backup reminder) | Port 443 — works on hosts that block SMTP egress. |
| **Rate limiting** | Upstash Redis | Distributed counters for OTP, login and recovery endpoints. |
| **Observability** | pino structured logs, Sentry | Every money path logs with a correlation id. |
| **Ops** | nginx, PM2, certbot (Let's Encrypt), ufw, crontab — Ubuntu 24.04 LTS | See [Deployment](#deployment). |
| **Testing** | Vitest (802 unit), Hardhat (106 contract), on-chain lifecycle script (23), Playwright (10) | See [Verification](#verification). |

---

## Architecture

```
┌──────────────┐  email OTP    ┌──────────────────┐
│  Browser SPA │◀─────────────▶│  Circle UCW      │  user-controlled wallet
│  (public/)   │  PIN signing  │  (hosted iframe) │  non-custodial, EOA
└──────┬───────┘               └──────────────────┘
       │ fetch
       ▼
┌──────────────────────┐       ┌──────────────────────┐
│  Next.js App Router  │◀─────▶│  Supabase Postgres   │
│  app/api/**          │       │  RLS on every table  │
└──────┬───────────────┘       └──────────────────────┘
       │ viem (DCW relays)
       ▼
┌──────────────────────┐       ┌──────────────────────┐
│  MarketEscrow.sol    │──────▶│  Indexer (cron)      │
│  Arc testnet         │events │  chain → DB reconcile│
└──────────────────────┘       └──────────────────────┘
```

- **Contract** — `contracts/MarketEscrow.sol`: escrow deals, marketplace orders, collateral,
  disputes, timeout escapes, operator gas budgets.
- **App** — Next.js App Router API plus a Babel-in-browser React SPA in `public/`.
- **Wallet** — Circle **User-Controlled Wallets**. Login is email OTP; the user signs with a PIN.
  Non-custodial, but no seed phrase to lose.
- **Indexer** — a cron job reconciles on-chain events back into Postgres. This is the **only
  self-healing path**: several contract actions are one-way (`markDelivered` cannot be called
  twice), so if the app's post-signature write is lost, the indexer is what repairs the DB.
  Every lifecycle event the contract emits has a handler.

### How state stays in sync — two paths, deliberately

An escrow app has to survive a lost HTTP response between "the transaction landed" and "the row
was updated". Two independent mechanisms cover that, and they are designed to be **safe to run at
the same time**:

| Path | Mechanism | Latency | Role |
|---|---|---|---|
| **Push** | Circle Smart Contract Platform event monitors → `POST /api/webhooks/escrow` | seconds | Real-time status updates. The raw log is decoded with viem against the generated ABI. |
| **Pull** | Cron → `GET /api/admin/indexer/run` | ≤ 1 minute | Safety net + repair. Advances a block cursor, backfills anything the push path missed. |

Both write the **same terminal values** for the same contract id, so running them concurrently is
idempotent by construction. Every delivery is additionally deduped on `sha256(raw body)` against a
unique constraint — Circle retries, and a retry must never re-apply a state transition.

Webhook signature verification (RSA-SHA256 over the raw body) is **mandatory**, and the raw body is
read with `req.text()` before parsing so the signature covers exactly the bytes Circle signed.

### Background jobs

Nine scheduled jobs keep the system honest. They are declared in one place —
`scripts/scheduler.js` — where each entry pairs a cron expression with the
internal endpoint it calls:

| Job | Cadence | Purpose |
|---|---|---|
| `indexer/run` | **1 min** | Advance the chain cursor; mirror contract events into the DB. |
| `auto-release` | 5 min | Settle orders whose inspection window has elapsed. |
| `sweep/allowance` | 5 min | Revoke residual USDC allowances left after settlement. |
| `sweep/drafts` | 10 min | Expire unpaid checkout drafts so stock is not held hostage. |
| `reconcile/onchain-releases` | 5 min | Repair releases that landed on-chain but never wrote back. |
| `reconcile/onchain-ids` | 5 min | Backfill contract ids for rows created before the push path existed. |
| `reconcile/failed-withdrawals` | 5 min | Retry or surface withdrawals that failed mid-flight. |
| `cross-chain/relay` | 5 min | Complete CCTP bridge legs started on a source chain. |
| `reconcile/balance` | 1 hour | Compare on-chain balances with the DB and flag drift. |

Every job is protected by a shared `CRON_SECRET` and is safe to run twice.

---

## User flows

### 1. Sign up / sign in — no seed phrase

```
email → Circle-hosted OTP → Circle provisions PIN + wallet → session cookie
```

1. The browser asks our API for an OTP; we call Circle's email-token endpoint and Circle sends the
   code itself — we never see or store it.
2. The user enters the code in Circle's hosted UI, which returns a `userToken` + `encryptionKey`.
3. `POST /api/auth/unified` verifies the token **against Circle** before trusting the email,
   upserts the user row, and sets httpOnly session cookies.
4. If the account has no wallet yet, Circle's hosted UI runs one challenge that sets the 6-digit PIN
   **and** creates the Arc wallet.

The result is a non-custodial wallet with no recovery phrase: the key is split (MPC) so a stolen
database is not a stolen wallet.

### 2. Buy a product (marketplace order)

```
Buy → approve USDC → escrow holds funds → seller delivers → buyer confirms → released
```

1. `checkout/prepare` validates the cart, gates the balance and creates a `PENDING` draft.
2. `checkout/challenge` returns a Circle `CONTRACT_EXECUTION` challenge for
   `USDC.approve(escrow, amount + fee)`; the buyer signs it with their PIN.
3. `checkout/confirm` verifies the approve transaction on-chain, then relays `createOrderFor`
   from the platform wallet so the buyer pays **no separate gas**.
4. The order walks `PENDING → PROCESS → SENT → DONE`; the buyer has a **42-hour inspection
   window** after delivery.
5. Confirmation (or the auto-release cron) relays `releaseOrder` — the seller receives
   `amount − 2%`, the platform keeps the 4% total.

### 3. Escrow / OTC deal — replacing the human middleman

```
List → buyer funds → seller locks collateral → deal room → release | refund | slash
```

1. The buyer funds the price (+2% fee) into `MarketEscrow.sol`.
2. The seller locks **fraud collateral** in the same contract — real money that is forfeited to the
   buyer if they are found to have defrauded.
3. Both sides talk in a deal room with an auditable timeline.
4. Settlement is one of:
   - **release** — seller gets `price` + collateral back,
   - **refund** — buyer gets `price` back, seller keeps collateral,
   - **refundEscrowWithSlash** — buyer gets `price + collateral` (fraud ruling).
5. If nobody acts, the **permissionless** timeout escapes settle the deal — a vanished operator
   cannot freeze funds, and a 30-day dispute backstop defaults to the buyer.

### 4. Dispute

Anyone can flag a dispute while the deal is live. That **freezes both clocks** and hands the case
to the admin console. The admin sees a deterministic brief — facts and contract state, **no
verdict** — and picks release, refund, or slash. Every ruling is written to an audit log.

### 5. Losing your email

An account can link an **external EOA** as a recovery wallet. If the email is ever lost, the user
signs a server-issued single-use nonce with that wallet (EIP-191) and gets their session back —
orders, store, history. Money actions that sign with the Slime wallet still require a normal
email-code login, and the UI says so rather than pretending otherwise.

---

## Verification

This is a system that moves money, so the claims above are backed by tests you can run.

| Suite | Command | What it proves | Count |
|---|---|---|---|
| Unit | `npm run test:unit` | Fee math, guards, schemas, permit/UCW logic | **802** (70 files) |
| Contract | `npm run test:contracts` | Escrow semantics, guard rails, settlement clocks | **106** |
| **On-chain** | `npm run test:onchain` | Full lifecycle against the **live Arc testnet contract**, real transactions | **23** |
| E2E UI | `npx playwright test` | SPA flows in a real browser | **10** |
| Security | `npm run security:sweep` | No anon-callable `SECURITY DEFINER` functions, RLS on every table, sensitive RPCs rejected | — |

`npm run test:onchain` is the one that matters most: it drives `createEscrowDeal` →
`depositEscrowCollateral` → collateral top-up → `markDelivered` → `confirmEscrow` with **real
USDC on Arc**, then asserts balances moved — plus guard rails that must **revert** (wrong
caller, delivery past deadline, release while undelivered, double funding).

The full product flow has also been exercised end-to-end **through the UI with a freshly created
account**: real email OTP login → PIN/wallet setup → buy → seller proceeds with collateral →
mark delivered → buyer confirms → released.

---

## Getting started

### Prerequisites

- Node 20+
- Docker (for the local Supabase stack) — or a Supabase Cloud project
- A Circle account (API key + entity secret) for wallet provisioning

### Setup

```bash
npm install
cp .env.example .env.local     # fill in Supabase + Circle keys
npx supabase start             # local Postgres / Auth / Storage
npm run db:migrate             # apply supabase/migrations
npm run dev                    # http://localhost:3000
```

> ⚠️ **Do not run `npx supabase db reset` in this repo.** It fails partway (`duplicate key` on
> `schema_migrations`) *after* it has already dropped the schema — you lose your data and the
> later migrations never apply. To apply one migration by hand:
>
> ```bash
> docker exec -i supabase_db_slimemarket psql -U postgres -d postgres < supabase/migrations/00NN_name.sql
> ```

### The cron process is required — even locally

`npm run dev` does **not** start the scheduler, and nothing else does. Without it the background
jobs never fire: the escrow indexer never advances its cursor, expired drafts are never cleaned
up, auto-release never settles. `/api/health` flips to `503 degraded` once the indexer falls too
far behind.

```bash
npm run cron      # second terminal — node scripts/scheduler.js
```

If you forgot it and health says `degraded`, catch the indexer up in one shot:

```bash
npx tsx --env-file=.env.local scripts/tools/indexer-catchup.mjs
```

### Before building: check disk space

`next build` writes ~113 MB to `.next` and needs headroom. On a full disk it fails with a
misleading error — Windows reports `EPERM ... open '.next\trace'` instead of `ENOSPC`, which
looks like a permissions problem but is not.

```bash
node scripts/tools/disk-free.mjs     # prints free GB + a verdict
```

### Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run cron` | Background scheduler — **required** locally |
| `npm run build` | Production build |
| `npm test` | Unit + contract tests |
| `npm run test:onchain` | Full lifecycle against live Arc testnet |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `npm run lint:fe` | ESLint / SPA JSX parse check |
| `npm run security:sweep` | Live DB security audit |

---

## Deployment

The app is a single Node process behind nginx, talking to Supabase Cloud and Circle. Nothing is
stateful on the box, so a rebuild is the recovery plan — but the **environment file is not
reproducible** and must be backed up separately.

### What it needs

| Piece | Requirement |
|---|---|
| App server | Any Linux host with Node 22 and ~1 GB free RAM. No special hardware. |
| Database | A Postgres instance with the migrations applied — Supabase Cloud or self-hosted. |
| Reverse proxy | nginx + a TLS certificate (certbot / Let's Encrypt). |
| Process manager | PM2 in fork mode, or any equivalent. One Node instance is enough. |
| Scheduler | Any cron that can `curl` the nine endpoints (see `scripts/scheduler.js`). |
| Firewall | Only 22 / 80 / 443 open. Circle's webhook IPs are allowlisted in-app. |

Nothing here is provider-specific — it runs on a small VPS or a PaaS, as long as the environment
variables are set and the cron jobs fire. Colocating the app and the database in the same region is
worth doing for latency, but it is not a requirement.

### First deploy

```bash
# 1. Harden + base packages
adduser deploy && usermod -aG sudo deploy
ufw allow 22,80,443/tcp && ufw --force enable
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

# 2. Node 22 (a distro default is usually older — use NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs nginx
npm i -g pm2

# 3. Code + environment
git clone https://github.com/SlimeMarket/slimemarket.git /srv/slimemarket
cd /srv/slimemarket && npm ci
cp .env.example .env.production      # then fill it — see below

# 4. Migrations, build, run
npm run db:migrate                   # applies supabase/migrations in order
npm run build
pm2 start npm --name slime -- start  # next start
pm2 save && pm2 startup              # survive reboot

# 5. TLS
certbot --nginx -d <your-domain> -d www.<your-domain>

# 6. Scheduler — the jobs are declared in scripts/scheduler.js
crontab -e
# * * * * *   curl -fsS -H "x-cron-secret: $CRON_SECRET" https://<your-domain>/api/admin/indexer/run
# */5 * * * * curl -fsS -H "x-cron-secret: $CRON_SECRET" https://<your-domain>/api/admin/auto-release
# … (see scripts/scheduler.js for the full list)
```

### Environment

`npm run make:prod-env` scaffolds `.env.production` from the template. The values that must be
right, or the app silently half-works:

| Group | Keys | Failure mode if wrong |
|---|---|---|
| Circle | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_APP_ID` | No wallet provisioning; sign-in dead-ends. |
| Contract | `ESCROW_CONTRACT_ADDRESS`, `ESCROW_START_BLOCK` | Indexer reads the wrong contract — or none. |
| Arc | `ARC_RPC_URL`, `ARC_CHAIN_ID` | Wrong chain ⇒ transactions never confirm. |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Nothing loads. |
| Cron / webhook | `CRON_SECRET`, `WEBHOOK_SECRET` | Jobs and webhooks are rejected (fail-closed, on purpose). |
| Mode | `CIRCLE_PAYMENTS_MOCK=0`, `FORCE_REAL_UCW=true` | Production refuses to boot in mock mode. |

> ⚠️ `.env.local` and `.env.production` must point at the **same** contract address. There is a
> checker for exactly this footgun:
>
> ```bash
> node scripts/tools/check-contract-addresses.mjs
> ```

### Operating it

| Task | Command |
|---|---|
| Health (DB, indexer lag, Circle) | `curl -s https://slimemarket.app/api/health` |
| Catch the indexer up by hand | `npx tsx --env-file=.env.production scripts/tools/indexer-catchup.mjs` |
| Deploy a change | `git pull && npm ci && npm run build && pm2 reload slime` |
| Read a deal straight from chain | `node scripts/tools/read-escrow-deal.mjs <id>` |

A `503` from `/api/health` means the indexer has fallen too far behind — that is the one alarm worth
wiring to a phone. See `docs/VPS_DEPLOYMENT_CHECKLIST.md` for the full preflight.

---

## Layout

```
contracts/          MarketEscrow.sol — escrow, collateral, disputes, timeout escapes
app/api/            route handlers: auth, wl, orders, admin, webhooks…
lib/
  contracts/        viem clients, contract bindings, event indexer
  wl/               WL deal state machine + transitions
  order/            marketplace order state machine
  circle/           Circle UCW provisioning
  arc/              chain config (5042002, USDC native) + viem client
  fee.ts            fee model — single source of truth
  money.ts          string → BigInt micro-USDC (no floats)
public/             the SPA (Babel-in-browser React)
supabase/migrations schema + RLS + RPCs, in order
test/               Hardhat contract tests
__tests__/          Vitest unit tests
e2e/                Playwright specs
scripts/            ops + verification tooling
docs/               runbooks (mainnet, VPS, testing)
```

## Status

Running on **Arc testnet**. The contract is deployed and verified, the full escrow lifecycle is
proven on-chain, and the app is wired to the live contract. Mainnet migration is staged in
`docs/MAINNET_LAUNCH.md` behind a preflight that checks the two things that actually kill an
escrow launch: an empty platform wallet and an empty deployer.

### Live on Arc testnet

| | |
|---|---|
| **Network** | Arc testnet (chain id `5042002`) |
| **MarketEscrow** | [`0x86feedea5c340f0fb0b0f9649691e87f5717b345`](https://testnet.arcscan.app/address/0x86feedea5c340f0fb0b0f9649691e87f5717b345) |
| **Settlement token** | USDC (native gas + value) |

You can verify the deployment yourself — the contract exposes its own parameters on-chain:

```bash
node scripts/tools/check-contract-addresses.mjs   # reads the live contract, checks env pointers
node scripts/tools/read-escrow-deal.mjs <id>      # dumps any deal's full on-chain state
```

`check-contract-addresses.mjs` reads `MIN_DELIVERY_WINDOW` / `CONFIRM_WINDOW` / `owner` straight
from the deployed bytecode, so a stale address (or a build missing a feature) is caught
immediately instead of at settlement time.

---

## Roadmap

**Shipped** — escrow contract + on-chain lifecycle · marketplace orders · WL / OTC deals with
collateral and slash · disputes with an audit trail · Circle UCW email-OTP onboarding · external
wallet recovery · cross-chain funding (CCTP) · invoicing + transactional email · admin console ·
802 unit / 106 contract / 23 on-chain / 10 e2e tests green.

**Next** — mainnet migration (staged in `docs/MAINNET_LAUNCH.md`) · reputation and dispute history
surfaced on seller profiles · an SDK for the Telegram bots these trades already run in, so a deal
can be opened from the chat window it is negotiated in · fee-tiered collateral limits.

**Later** — multi-chain settlement beyond Arc · a public dispute-arbitration pool to replace the
single admin arbiter · fiat on-ramp for non-crypto-native buyers.

---

## Docs

| Doc | Contents |
|---|---|
| `docs/VPS_DEPLOY_RUNBOOK.md` | Step-by-step production deployment |
| `docs/VPS_DEPLOYMENT_CHECKLIST.md` | Production environment checklist |
| `docs/MAINNET_LAUNCH.md` | Ordered mainnet runbook + preflight |
| `docs/TEST_PLAYBOOK.md` | How to test end-to-end |
| `docs/UCW_AUTH_LAYERS.md` | Wallet auth layers + account recovery |
| `docs/ESCROW_OTC_TODO.md` | Escrow / OTC design decisions |

---

## License

The source is released under the **MIT License** — see [`LICENSE`](LICENSE). You are free to read,
fork, modify and run it, including commercially.

Two things the license does **not** cover, because they were never part of the repository:

- **The brand.** The SlimeMarket name, logo and visual identity are not licensed for reuse. A fork
  is welcome; shipping it under our name is not.
- **The deployment.** The live escrow contract is owned by the deployer wallet, and the running
  service is bound to a Circle account and a database. Forking the code gives you none of those.

If you build on this, we would genuinely like to hear about it.

