# TODO — Escrow / OTC: What Needs Fixing & Building

> Created 2026-09-30. Result of auditing `contracts/MarketEscrow.sol`, `supabase/migrations/`,
> `public/wl.jsx`, `public/escrow.jsx`.
>
> Context: the platform = an **OTC P2P marketplace** (migrated from Telegram), with
> trustless escrow replacing the human rekber. **Admin = middleman = arbitrator.**

---

## 📊 PROGRESS (update 2026-09-30, execution session)

| Item | Status | Evidence |
|---|---|---|
| **C1** collateral top-up | ✅ **DONE** | `depositEscrowCollateral` can now be called repeatedly; test "collateral can be TOPPED UP" |
| **C2** two deadlines (race fix) | ✅ **DONE** | `deliveryDeadline` + `confirmDeadline`; escape hatches mutually exclusive; test "RELEASE is blocked while the deal is undelivered — this is the race fix" |
| **C3** slash collateral to buyer | ✅ **DONE** | `refundEscrowWithSlash()` + event `DealRefundedWithSlash`; test "pays the buyer price + collateral" |
| **C4** flexible timeout | ✅ **DONE** | Per-deal `deliveryWindow`, clamp `[MIN 1 hour, MAX 1 year]`; test "airdrop case: months out" |
| **C5** DISPUTED state + freeze | ✅ **DONE** | `flagDispute()` + `disputed` flag blocks the escape hatch; test "a dispute FREEZES the release escape hatch" |
| **C6** buyer confirmation | ✅ **DONE** | `confirmEscrow()` / `confirmOrder()` — buyer can release themselves, without an admin |
| **D1** DISPUTED in DB | ✅ **DONE** | Migration `0071`; constraint verified on the local DB |
| **D2** deadline columns in DB | ✅ **DONE** | `delivery_deadline`, `confirm_deadline`, `delivered_at`, `disputed_at`, `collateral_slashed` — verified |
| **Bonus** per-listing window | ✅ **DONE** | `wl_listings.delivery_window_seconds` (the seller decides) |
| **TS binding** | ✅ **DONE** | `escrow-client.ts` + `lib/wl/*` updated; `tsc --noEmit` clean |
| **Testnet deploy** | ✅ **DONE** | `0x39908c1a572277a5a2eb615bde9be0e7ea55e4c6` (block 64874321), owner/treasury/MM verified |
| **Testnet E2E** | ✅ **DONE** | `scripts/e2e-escrow-testnet.ts` — **16/16 passing** with real transactions |
| **Migration 0072** | ✅ **DONE** | RPC lifecycle (mark-delivered, dispute, slash) + release/refund accept DISPUTED |
| **`lib/wl` transition** | ✅ **DONE** | `markDeliveredDeal`, `flagDisputeDeal`, `confirmDealAsBuyer`, `slashDeal` |
| **New API routes** | ✅ **DONE** | `mark-delivered`, `confirm-receipt`, `dispute`, `slash` + a generic validator |
| **A2** payment gate | ✅ **CONTRACT DONE** | Collateral-first shell flow live on testnet; app wiring remains |
| **A1** standalone WTB | ✅ **DONE** | `side` column + direction-aware `create_wl_deal` + two-book UI |
| **D3** OTC proof-of-payment | ✅ **DONE** | 2 one-way caps + delivery gate |
| **UI** (deadline/dispute/top-up) | ✅ **DONE** | 2-hour deadline, per-role buttons, dispute, collateral top-up, slash |

**Verification:** **60 contract tests passing** · **597 unit tests passing** · `tsc --noEmit` clean ·
`lint:fe` 31 files parse OK · testnet E2E **23/23 passing** · DCW relay **9/9 passing** ·
A1+D3 smoke **10/10 passing**.

**Live contract (Arc Testnet):** `0x86feedea5c340f0fb0b0f9649691e87f5717b345`

**Deploy note:** the contract changed → **REDEPLOY REQUIRED** (already done).
`hardhat.config.cjs` uses `viaIR: true` (required — the relayer entry point exceeds the stack slot limit).

**Test wallets (Arc Testnet):** see `scripts/test-wallets.ts`.
Deployer `0x069fB5…bb8D` · Test buyer `0x0b2aC7…465cA` · Test seller `0x6b53a8…D1E9`.
Platform DCW `0x8fa565…7eb83` (owner + treasury + operator + middleman).

---

## ✅ What ALREADY exists (don't rebuild it)

| Feature | Location | Note |
|---|---|---|
| WTS listing (seller) | `public/wl.jsx` | — |
| Deal room + chat | `lib/wl/chat.ts` | Price & collateral negotiation |
| **Form first, pay later** | status `MENUNGGU` | *"Buyer funds & seller collateral are not held yet"* |
| Seller sets collateral → Proceed → both enter escrow | `escrow.jsx` line 243 | — |
| Without collateral (per type) | `wl.collateralNone` | Wallet Submit / Discord Surrender = no collateral |
| Release / refund | `MENUNGGU → ESCROW → SELESAI/BATAL` | — |
| "Make Offer" (buyer bids) | `wl.jsx` line 102-111 | The seed of WTB |
| Admin = middleman | `addMiddleman` = `onlyOwner` | No third party needed |
| Dispute (marketplace) | `orders.status` + `resolve_dispute_rpc` | ⚠️ But **only for `orders`**, not `wl_deals` |

---

## 🔴 CONTRACT — `contracts/MarketEscrow.sol`

### C1. Collateral can only be set ONCE
```solidity
// line 236
require(d.collateral == 0, "collateral already set");
```
**Problem:** the buyer asks to add collateral → **revert**. There's also no way to reduce it.
**Fix:** add `addEscrowCollateral(dealId, extra)` that can be called repeatedly
(or loosen the require).
**Priority:** 🔥 High — this is the user's main negotiation flow.

### C2. Race condition after timeout
```solidity
releaseEscrowAfterTimeout → require(block.timestamp > d.createdAt + ESCROW_TIMEOUT)
refundEscrowAfterTimeout  → require(block.timestamp > d.createdAt + ESCROW_TIMEOUT)
```
**Problem:** the conditions are **IDENTICAL**, both are **permissionless** → whoever calls first wins.
**Fix:** split into **two deadlines**:
- `deliveryDeadline` — passing this without shipping → **buyer can refund**
- `confirmDeadline` — after the seller marks it shipped, the buyer stays silent → **release to the seller**

**Priority:** 🔥 High — more dangerous the longer the timeout.

### C3. Collateral always goes back to the seller — fraud insurance doesn't work
```solidity
// line 252 (release) & 268 (refund):
usdc.safeTransfer(d.seller, d.collateral);
```
**Problem:** grepping `collateral` + `buyer` only turns up the event declaration.
**There's no path for collateral to the buyer** → a seller can commit fraud and still get the collateral back.
**Fraud context (from the user):** the buyer funds the mint wallet with their own money; a malicious seller
sends the mint funds to another wallet OR mints the NFT to another wallet → **the collateral must be passed
to the buyer as compensation.**
**Fix:** `refundEscrowWithSlash(dealId)` → the buyer receives `price + collateral`.
Or a resolution parameter (`REFUND` vs `REFUND_WITH_SLASH`). Log it to `mm_audit_log`.
**Priority:** 🔥 High — this is the core value proposition of escrow.

### C4. Timeout hardcoded to 7 days
```solidity
// line 46
uint256 public constant ESCROW_TIMEOUT = 7 days;
```
**Problem:** real OTC sometimes has deliveries that take **months** (e.g. an airdrop-eligible
wallet, where the claim isn't available for another 3 months). 7 days is too short → **the buyer's money is lost**.
**Fix:** timeout **per-deal**, set by the seller at listing, **shown to the buyer before
paying**. With a **maximum cap** (e.g. 1 year).
**Priority:** 🔥 High.

### C5. ⚠️ NO DISPUTED state / per-deal freeze
**Finding:** the contract only has a **global** `whenNotPaused` (14 usages).
There's no mechanism to freeze **just one deal**.
**Problem:** the buyer files a dispute → the seller can still call
`releaseEscrowAfterTimeout` after 7 days → **the seller gets paid, the dispute stops nothing.**
**Fix:** add a `disputed` flag to `EscrowDeal`; `*AfterTimeout` must
`require(!d.disputed)`.
**Priority:** 🔥 High — this is the most serious hole.

### C6. `releaseEscrow` doesn't require buyer confirmation
```solidity
function releaseEscrow(uint256 dealId) external onlyMiddleman ...
```
**Problem:** the admin can unilaterally release at any time after the buyer deposits.
**Fix (optional):** add a `buyerConfirmed` flag for the normal path, so the admin only
steps in during a dispute.
**Priority:** 🟡 Medium — depends on how much you trust the admin yourself.

---

## 🟡 DATABASE — `supabase/migrations/`

### D1. `wl_deals.status` has no `DISPUTED`
```sql
-- 0001_init.sql line 169
check (status in ('MENUNGGU','ESCROW','SELESAI','BATAL'))
```
**Problem:** `orders` has `DISPUTED`, `wl_deals` **doesn't**. Even though WL = the highest-risk
category.
**Fix:** add `'DISPUTED'` to the check constraint + its transition flow.
**Priority:** 🔥 High (the counterpart to C5).

### D2. `wl_deals` has no deadline columns
**Finding:** there's only `created_at`. No `delivery_deadline` / `confirm_deadline`.
**Fix:** add those two columns + `disputed_at`.
**Priority:** 🔥 High (the counterpart to C2 & C4).

### D3. OTC proof-of-payment doesn't exist yet
**Problem:** the `orders` status is oriented around **goods** (`PENDING→PROCESS→SENT→DONE`).
OTC needs a state: **"buyer marks IDR paid" → seller confirms → release**.
**Fix:** add a state/flag specific to the fiat P2P flow.
**Priority:** 🟡 Medium — but this is what makes the product **work as OTC**.

---

## 🔵 APP

### A1. WTB (Want to Buy) as a standalone listing doesn't exist yet
**Now:** only "Make Offer", which is **attached to a seller listing** (`wl.jsx` line 102).
**What's missing:** the buyer creates their own listing (*"looking for 1000 USDC @ 16,400"*) that sellers
can find.
**Why it matters:** this **solves the liquidity problem** (the #1 problem for a new marketplace),
and it's **exactly how Telegram OTC groups work** → users are already familiar.
**Bonus:** WTS + WTB = a **spread** → a market price → people show up.
**Fix:** add a `side: 'WTS' | 'WTB'` column to `wl_listings`, reuse the existing form
(reversed in direction). Most likely **no new table needed**.
**Priority:** 🔥 High — the biggest impact on liquidity.

### A2. Payment gate: buyer can pay before collateral exists
**Problem:** `createEscrowDealFor` sets `buyerDeposited = true` **at creation**
(the buyer pays first), while `depositEscrowCollateral` is called **separately**.
→ There's a window where **the buyer's money is already in escrow but the collateral isn't there yet.**
**Fix (off-chain, doesn't touch the contract):**
```
1. Chat → agree on collateral X        (store in DB)
2. Seller deposits collateral on-chain
3. Platform checks: on-chain collateral >= X ?   ← gate
4. Only then may the buyer pay
```
The `wl_deals.needs_collateral` + `seller_collateral` columns **already exist** — just use them.
**Priority:** 🔥 High — without this, the buyer's cancellation right means nothing.

**⚠️ FINDING DURING EXECUTION (2026-10-01):** the "collateral first, then pay" fix **can't be
100% off-chain.** The reason: `MarketEscrow.createEscrowDeal` **creates AND funds the deal
in one call** — the buyer's money leaves exactly when the on-chain deal is born. So
`depositEscrowCollateral` **always** runs afterwards; there's no on-chain deal to
attach collateral to before that.

**What WAS done (contract + gate):**

**Contract — `collateral-first` shell flow (deployed & proven on testnet):**
```solidity
createEscrowDealAsSeller(buyer, price, window, collateral)
// seller creates a shell deal WITHOUT the buyer's money + deposits collateral in ONE tx

fundEscrowDeal(dealId)
// buyer funds. REVERTS if collateral == 0 → STRUCTURAL gate
```
- The delivery clock (`deliveryDeadline`) starts at **funding**, not when the shell is created —
  so a buyer who funds late still gets the full window
- `refundEscrowAfterTimeout` is given a `buyerDeposited` guard — without it, an unfunded
  shell has `deliveryDeadline = 0` so the "deadline passed" check becomes true automatically
- Bug found & fixed: `refundEscrowWithSlash` on an unfunded deal
  **didn't transfer collateral at all** → funds got stuck. Now collateral
  is always paid to the buyer
- The struct gets a `deliveryWindow` field at the **end** (index 16) so indexes [0..15] stay the same

**Off-chain gate (still used for old deals):**
- `readOnChainDealCollateral()` reads the collateral **directly from the contract**
- `evaluateCollateralGate()` in `proceedWlDealNonCustodial`
- Red warning UI if ESCROW but collateral is 0

**REMAINING (app wiring):** the route + UI don't use the shell flow yet. Right now the app still uses the
old flow (buyer pays → seller deposits collateral), which **is still safe** because the gate
prevents a "protected" status without collateral. Switching to the shell flow = a UX
change (the seller creates the on-chain deal, not the buyer) — requires changing `confirmWlDeal` +
`proceedWlDealNonCustodial` + 2 new routes + a "Fund" button in the UI.

### A3. IDR topup route dead (410)
```
app/api/wallet/topup/route.ts → 410 SUPERSEDED_BY_ONRAMP
```
And Circle onramp only supports **USD/EUR/GBP — no IDR** (`lib/circle/onramp.ts` line 43).
**BUT:** in P2P OTC, IDR **doesn't go through the platform** (the buyer transfers directly to the seller's bank).
→ **No fiat on-ramp needed.** The platform is self-sufficient.
**Fix:** ⚪ **Nothing needs to be done.** Just make sure the UI doesn't offer a dead QRIS option.
**Priority:** ⚪ Low.

---

## 📋 Suggested priority order

| # | Action | Makes what work |
|---|---|---|
| 1 | **C5 + D1** — DISPUTED state + per-deal freeze | A real dispute actually stops settlement |
| 2 | **C2 + C4 + D2** — two deadlines + flexible timeout | Deterministic, fits monthly deals |
| 3 | **C3** — slash collateral path to the buyer | Escrow has teeth |
| 4 | **C1** — collateral top-up | Negotiation in the deal room works |
| 5 | **A2** — payment gate | The buyer is protected before paying |
| 6 | **A1** — standalone WTB | Liquidity |
| 7 | **D3** — OTC proof-of-payment | The product works as OTC |
| 8 | **C6** — buyer confirmation (optional) | Reduces admin risk |

**Note:** #1–#5 are **one package** — all about making escrow safe for long
deals. #6 (WTB) is independent and can be worked in parallel.

---

## ⚠️ What NOT to change

- **Don't throw away UCW-EOA.** MSCA = SCA → ERC-3009 dies. And MSCA doesn't resolve
  the crypto purist objection (neither is a key you can export).
- **Don't move off Arc.** Arc = the fastest chain on Circle Gateway (0.5 seconds vs
  13–19 minutes on major L2s).
- **Don't create a platform-enforced minimum collateral.** Let the buyer
  negotiate — every deal's needs differ.
- **Don't use a free PaaS tier with cron limits** — the scheduler needs nine
  sub-daily jobs, which most free plans refuse to deploy.
