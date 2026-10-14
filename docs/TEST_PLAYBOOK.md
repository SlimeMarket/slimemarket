# SlimeMarket — Testing Playbook

> How to exercise the full flow end-to-end: signup, buy, seller delivery, release,
> refund and dispute — without needing anyone to walk you through it.

> ⚠️ **The escrow contract address is `0x86feedea5c340f0fb0b0f9649691e87f5717b345`.**
> (`ESCROW_START_BLOCK=64889213`) — the same in `.env.local` & `.env.production`.
> Check any time: `node scripts/tools/check-contract-addresses.mjs`.
> References to `0xfe76c632…` below = historical notes, NOT the active configuration.

---

## 0. Facts you need to know up front

There are **two test modes**, and the difference matters:

| | **Track A — Dev-login** | **Track B — Real UCW** |
|---|---|---|
| Need Circle? | ❌ no | ✅ yes (OTP + PIN) |
| Wallet | **mock** (deterministic fake address) | real UCW (Circle MPC) |
| Escrow on-chain | ❌ not possible | ✅ yes |
| Setup speed | seconds | minutes |
| Good for testing | UI, cart, order state, seller, admin, ledger | login, PIN gate, escrow, paying with an external wallet |

**Track A cannot test on-chain escrow** because its wallet is a mock (fake address, zero balance).
If you want to test "pay → money enters escrow → seller gets paid", **Track B is required**.

---

## 1. Preparation

### 1a. Server

```bash
cd C:/Users/AMD/Downloads/SlimemarketAPP

# dev server (if it isn't running yet)
rm -rf .next
npm run dev
```

Open **http://localhost:3000**.

> ⚠️ Don't use `127.0.0.1:3000` interchangeably with `localhost:3000` in the same session.
> `NEXT_PUBLIC_APP_URL=http://localhost:3000`, and although `csrf-origin.ts` already
> tolerates loopback, being consistent is safer.

### 1b. Cron (if you want to test auto-release / reconcile)

```bash
npm run cron     # separate terminal; needs INDEXER_CRON_SECRET in .env.local
```

### 1c. Check the initial state

```bash
curl -s http://localhost:3000/api/health
```

What to expect now: **4 of 6 green**.

```
db      ✓ supabase-ok
rpc     ✓ block #...
circle  ✓ reachable
escrow  ✓ contract@0xfe76c632… (23286 bytes)
indexer ✗ indexer_state row missing — indexer never ran   ← normal before the cron runs
redis   ✗ UPSTASH_REDIS_REST_URL/TOKEN not set            ← normal locally
```

`indexer` turns green after `npm run cron` runs once (or
`curl -X POST -H "Authorization: Bearer $INDEXER_CRON_SECRET" localhost:3000/api/admin/indexer/run`).

### 1d. Current database state

Cleaned up on 2026-09-26:

| Table | Contents |
|---|---|
| `users` | **1** — `rimuru@slimemarket.app` (Admin) |
| `stores`, `products`, `orders`, `wl_deals`, `wallet_txs`, `ledger_entries` | **0** |

In Circle Console: 1 leftover probe user, **`smprobe1`** — delete it manually in
**Wallets → User Controlled → Users** (Circle does not provide a delete-user endpoint; 4 variants were tried, all 404).

---

## 2. Track A — quick test with dev-login

`POST /api/auth/dev-login` creates a user + mock wallet + immediately sets the session cookie.
**Only works when `NODE_ENV !== "production"`** (returns 404 in production).

Create 3 accounts at once:

```bash
for u in buyer1 seller1 mm1; do
  curl -s -X POST http://localhost:3000/api/auth/dev-login \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$u@slimemarket.app\"}" | head -c 200; echo
done
```

Change a role via admin (log in as `rimuru@slimemarket.app` first), or directly via SQL:

```sql
-- Seller
update users set role='Seller' where email='seller1@slimemarket.app';
-- Middleman
update users set role='MM'     where email='mm1@slimemarket.app';
```

Fund the balance (dev faucet — **404 in production**):

```bash
curl -s -X POST http://localhost:3000/api/wallet/dev/faucet \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"amountUsdc":"100"}'
```

What you can test in Track A:
- browse the catalog, cart, draft checkout, order status transitions (`PENDING → PROCESS → SENT → DONE`)
- seller creates a store + product listing + stock
- admin dashboard, treasury, moderation, pause
- earnings/ledger (custodial mode: DB ledger = source of funds)
- middleman up to `ESCROW` **at the DB level only** (no on-chain)

What you **cannot** do: anything that needs a real UCW balance.

---

## 3. Track B — real UCW test + on-chain escrow

### 3a. Flip the flags in `.env.local`

```diff
- CIRCLE_PAYMENTS_MOCK=1
- FORCE_REAL_UCW=false
- ONCHAIN_WALLET_FUNDS=0
+ CIRCLE_PAYMENTS_MOCK=0
+ FORCE_REAL_UCW=true
+ ONCHAIN_WALLET_FUNDS=1
```

**Restart the dev server** (env is read at boot).

> 🔴 **Important:** `ONCHAIN_WALLET_FUNDS` determines who pays.
> `=1` → money moves **on-chain** (UCW → MarketEscrow). `=0` → DB ledger only.
> On-chain escrow **will not happen** if this flag is 0. `curl /api/health` and make sure
> `"onChainFunds": true`.

### 3b. Buyer account signup (real)

1. Open http://localhost:3000 → **Log In / Sign Up**
2. Enter your email → **the OTP code is sent by Circle** (you already registered SMTP in Console ✓)
3. Enter the OTP in the Circle iframe
4. **A full-screen PIN gate appears** → *Create PIN → Verify ×2 → Security Questions*
5. Done → check `users.wallet_provisioned = true` and that a row exists in `wallets`

> If the PIN gate **does not appear**: that's a bug that was just fixed (`public/app.jsx` —
> the `/api/auth/me` bootstrap previously never ran after the first signup, so the gate only
> appeared after a reload). If it still doesn't appear, reload once and report it.

Verify in Circle Console → Wallets → User Controlled → Users:
the new user must have `PIN Status: ENABLED` and `Security Questions` filled in.

### 3c. Fund the UCW balance

`POST /api/wallet/dev/faucet {amountUsdc:"5"}` — with `ONCHAIN_WALLET_FUNDS=1`, this
sends **real USDC** from the platform DCW to the user's UCW.

> The platform DCW balance is only **4 USDC**. If it runs out, top it up first in
> Circle Console → Faucet, or from the Arc faucet to `0x8fA56501139c0f23Af234A24a13840950037Eb83`.

Check on-chain: `https://testnet.arcscan.app/address/<ucw-address>`.

### 3d. Test scenarios

**B1. Buyer pays with Slime Wallet (UCW)**
1. Seller creates a product (price e.g. 1 USDC)
2. Buyer → product → checkout → select **Slime Wallet**
3. A Circle PIN prompt appears → enter the PIN
4. Check:
   - `orders.on_chain_order_id` is filled (not NULL)
   - `orders.on_chain_status = 'CREATED'`
   - buyer's UCW balance drops by **1.02 USDC** (1 + 2% buyer fee)
   - `pendingFees` in the contract increases by 0.02 USDC
5. Seller marks as shipped → buyer confirms receipt
6. Check: `orders.status='DONE'`, `on_chain_status='RELEASED'`, seller receives **0.98 USDC**
   (1 − 2% seller fee)

**B2. Buyer pays with an external wallet (without depositing into the UCW)**
1. Checkout → select **Connect Wallet** → MetaMask/Coinbase
2. Sign the permit (gasless) — **do not** send an approve tx first; the permit path is cheaper
3. Same as B1 for the checks, but `orders.buyer_payer_wallet_type` = EOA

**B3. Middleman (WL)**
1. Buyer creates a WL deal with a seller + middleman
2. Buyer funds → `wl_deals.on_chain_deal_id` is filled, the status is still `MENUNGGU`
3. **Seller** clicks Proceed → status `ESCROW` (now uses the correct non-custodial RPC)
4. Release → seller receives **100% price** (no deduction on the seller side)
5. Refund (alternative path) → buyer gets back `price + 2%` **and** the seller's collateral

**B4. Auto-release after 42 hours**
- Change the order's `release_deadline` to the past via SQL, then
  `curl -X POST -H "Authorization: Bearer $INDEXER_CRON_SECRET" localhost:3000/api/admin/auto-release`
- The order must be `DONE` and the seller must be paid

---

## 4. What you MUST check in the DB for each scenario

```sql
-- order
select id, status, amount, payment, on_chain_order_id, on_chain_status,
       on_chain_circle_tx_id, buyer_payer_wallet_type
from orders order by created_at desc limit 5;

-- middleman deal
select id, status, price, on_chain_deal_id, on_chain_status,
       seller_collateral, on_chain_circle_tx_id
from wl_deals order by created_at desc limit 5;

-- ledger (custodial mode)
select * from ledger_entries order by created_at desc limit 10;

-- incoming webhook
select notification_type, mapped_status, created_at from webhook_events
order by created_at desc limit 10;
```

On-chain: `pendingFees()`, `orderCounter()` at
`https://testnet.arcscan.app/address/0xfe76c63289dd8b5693277df261e4938bd8779d28`

---

## 5. Expected numbers (canonical)

| Flow | Buyer pays | Seller receives | Platform |
|---|---|---|---|
| Marketplace | `price + 2%` | `price − 2%` | **4%** |
| Middleman / WL | `price + 2%` | `price` (100%) | **2%** |

The buyer fee is **non-refundable** — it is still kept even if the order is refunded.
There is no $4 base fee, and no gas fee charged to the buyer.

Example with a price of 1 USDC:
- Marketplace: buyer pays **1.02**, seller receives **0.98**, platform **0.04**
- Middleman: buyer pays **1.02**, seller receives **1.00**, platform **0.02**

---

## 6. Known pitfalls (don't waste time)

| Symptom | Cause | Action |
|---|---|---|
| PIN gate doesn't appear after signup | Already fixed. Remaining possibility: `CIRCLE_APP_ID` is empty | Check `/config.js` → `circleAppId` must be filled |
| OTP doesn't arrive | Circle Console SMTP / SPF+DKIM | You already registered it ✓; if it still fails, check the spam folder |
| `escrowAddress` doesn't appear in the FE | `/api/health` hasn't been called | Wait a moment; it now **fails hard** if empty, instead of using the wrong address |
| Checkout returns 422 `PIN_SETUP_REQUIRED` | User skipped the PIN gate | Complete the PIN from the Profile page, or retry |
| `on_chain_order_id` is NULL even though the money already entered escrow | The relay to Circle timed out reading the receipt | Wait for the `reconcile/onchain-ids` cron (5 minutes) — **it now actually runs** (previously 401) |
| Indexer cron returns 401 | `INDEXER_CRON_SECRET` is empty | Fill it in `.env.local` |
| Money endpoints return 500 | `UPSTASH_REDIS_REST_*` is empty (rate-limit fails CLOSED in production) | Normal locally; required before production |

---

## 6b. Available helper commands

```bash
npm run typecheck        # tsc --noEmit (backend/TS)
npm run lint:fe          # parse 31 .jsx files in public/ using esbuild
npm test                 # vitest run (489 tests)
npm run cron             # scheduler job (indexer, auto-release, reconcile)

npm run db:migrate -- --list        # list migrations + ready-to-paste psql commands
npm run db:migrate -- --from 0070   # commands for 0070 and later
npm run users:cleanup               # DRY RUN: list test accounts
npm run users:cleanup -- --apply    # delete (backup to .secrets/ first)

npm run events:gen       # regenerate ABI events from contracts/MarketEscrow.json
npm run events:verify    # check the artifact topic hash is present in the contract bytecode
npm run monitors:list    # list SCP event monitors in Circle
npm run monitors:setup   # register monitors that don't exist yet
npm run monitors:setup -- --prune   # + remove monitors with stale signatures
```

> `db:migrate` **only prints the commands**, it does not run them. Node cannot spawn
> `docker.exe` in some environments (it fails with `EBUSY`), so you paste the commands yourself
> in a regular terminal. Safe and always verifiable.

---

## 6c. Escrow webhook via tunnel (optional, already automated)

The escrow webhook needs the **one** thing that can't run on localhost: a public URL, because
Circle has to reach us. The solution is free, one command:

```bash
# terminal 1
npm run dev

# terminal 2
npm run tunnel
```

`npm run tunnel` will:
1. start a Cloudflare quick tunnel to `localhost:3000`,
2. print the public URL + verify `HEAD /api/webhooks/escrow → 200`,
3. **register the Circle subscription automatically** (deleting the old tunnel subscription first,
   because the quick tunnel URL changes on every restart).

Leave terminal 2 open. If the tunnel is shut down, the URL is gone and the webhook stops — just
run `npm run tunnel` again and everything re-registers itself.

Verify that the chain is actually live:

```bash
npm run webhook:verify
```

It triggers a real on-chain event (`collectFees()` → `FeesCollected`) and then waits for its webhook to arrive.
Expected result: `✓ WEBHOOK DITERIMA` within ~10 seconds. This is **not** a simulation — the event
is genuinely emitted by MarketEscrow, caught by the Circle monitor, and pushed through the tunnel.

```bash
npm run webhook:list     # active subscriptions + their endpoints
```

> ⚠️ If you **don't** want to use a tunnel: the webhook is entirely optional. The indexer cron
> (`/api/admin/indexer/run`) already syncs escrow events via polling. The webhook only makes
> synchronization instant, not sub-second.

---

## 7. Before deploying to production

- [ ] `UPSTASH_REDIS_REST_URL` + `_TOKEN` filled in (the old token **leaked**, rotate it first)
- [ ] `NEXT_PUBLIC_APP_URL` = final domain (if wrong → every POST 403 CSRF)
- [ ] `INDEXER_CRON_SECRET` set to something strong
- [ ] Secret-scrub commit (2 old commits still contain secrets; the repo is PUBLIC)
- [ ] `CIRCLE_PAYMENTS_MOCK=0`, `FORCE_REAL_UCW=true`, `ONCHAIN_WALLET_FUNDS=1`
- [ ] Webhook subscription → `node scripts/setup-webhook-subscription.mjs --create https://domainmu.com`
      (after deploy; **do not** use a tunnel in production). See §6c below.
- [ ] Scheduler running (VPS: `npm run cron`; Vercel: built-in cron, but Hobby is only once/day)
