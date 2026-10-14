# Fiat rails: on-ramp & off-ramp — what to actually do

> 2026-10-07. Question: should we turn on fiat deposit (on-ramp) + withdraw (off-ramp)?
> Constraints raised: **no Stripe account**, and **an Indonesia-only bank** — so what about global users?

Short answer: **for on-ramp, neither constraint is relevant.** For off-ramp,
**do not build it yourself** — and not because it is hard.

---

## 1. On-ramp: you ALREADY have one, and it does not need Stripe

What you have today (`public/balance.jsx` → the **"Buy with card/bank"** tab) is the
**Circle Onramp widget** — hosted, and **Circle is the licensed party**.

From the official documentation:

> The widget is hosted on Arc and **handles KYC, payment processing, and settlement**.

Which means: **Stripe is not needed at all.** Circle holds the KYC plus the card/bank relationship.
All you need is a **Circle API key** (you have one) and — this is the part still missing —
**KYB completed in the Circle Console**.

### Methods & coverage (from the docs)

| Method | Coverage | Requirement |
|---|---|---|
| **Debit card, Apple Pay, Google Pay** | US, UK, part of the EU, **and other countries worldwide** | **KYB** required in the Circle Console |
| **Bank transfer** | USDC in **some US states + part of the EU** | — |
| **Credit card** | ❌ **not supported** | — |

### 🎯 Why your Indonesian bank is a non-issue

**Your bank is not used at all.** The payer is the **buyer's own card/bank**, and
Circle settles the USDC to the destination wallet address. Your bank's involvement is zero.

So the worry *"my bank is Indonesia-only, how does that work for global users?"* — **it does not apply to on-ramp.**

### What needs doing
1. **KYB in the Circle Console** (`console.circle.com/app-kits/`) → enables debit card / Apple Pay / Google Pay
2. Make sure the server sends **`referrerDomain`** when minting the session (without it the widget cannot be embedded)
3. API keys **separate per environment** (sandbox vs production)

### Status in this repo (checked 2026-10-07)

| | Status |
|---|---|
| `referrerDomain` wiring | ✅ Correct — `lib/circle/app-kit.ts` derives the **bare hostname** from `NEXT_PUBLIC_APP_URL` (not from a request header) |
| `NEXT_PUBLIC_APP_URL` | ✅ Set — `localhost:3000` (dev) / `slimemarket.app` (prod) |
| Session mint | ✅ **Proven 200**, and the token contains `"referrerDomain":"localhost"` |
| Provider | **Transak** — the token carries a `transakKybApproved` field, so KYB really is what gates it |
| `APP_KIT_API_KEY` | ✅ **Installed** (2026-10-07) — a dedicated App Kit key, in `.env.local` + `.env.production`. Falls back to `CIRCLE_API_KEY`, and logs a warning when empty |
| `APP_KIT_ENV` | ⚠️ `sandbox` — **CORRECT for testnet right now**, and **now guarded by an assertion** (see below) |

**The only blocker is KYB.** Everything else is wired and proven to work.

⚠️ **Mainnet note:** the key currently installed is `TEST_API_KEY:…` (sandbox). When you move to mainnet,
besides switching `APP_KIT_ENV=production`, **the key itself must also be swapped for a production key** —
a test key is rejected by the production API. The assertion below catches the env mismatch, but it does
**not** catch a test key being used in a production environment. Put this on the mainnet checklist.

### 🛡️ Why `APP_KIT_ENV=sandbox` must NOT be changed right now

The temptation: "this is production, switch it to `production`." **That would actively break things.**

`APP_KIT_ENV` selects the **Circle environment** (sandbox → Arc testnet, production → Arc mainnet),
while the chain is selected **separately** by `ARC_CHAIN_ID`. Today `ARC_CHAIN_ID=5042002`
= **testnet**, so `sandbox` is the **correct counterpart**.

Force `production` while the chain is still testnet and the on-ramp will deliver **mainnet USDC to a
testnet address**.

**And the problem is that both look healthy until money moves.** That is why
`assertOnrampMatchesChain()` now guards it in `lib/circle/app-kit.ts`:

- It runs **every time** `appServerKit()` is called (not just once — a cache must not be allowed
  to hide a mismatch)
- A mismatch → **throws with a message naming the value that must be set**
- Including the most dangerous case: `APP_KIT_ENV` **unset** on a testnet chain → it defaults to
  `production` → caught
- 7 tests in `__tests__/lib/onramp-chain-consistency.test.ts`

So the **mainnet checklist is now automatic**: the moment `ARC_CHAIN_ID` is switched to `5042`, the
on-ramp immediately refuses to run until `APP_KIT_ENV` is switched too. You cannot forget it.

---

## 1b. Bridge (CCTP): **works on Arc testnet** — but there is a trap

**One correction:** CCTP **can** be used on Arc testnet. Circle's official docs list `Arc_Testnet`
in the `BridgeChain` enum **and** in the CCTP supported-blockchains table (domain `26`).
The Arc docs even ship a bridge quickstart whose example is `Ethereum_Sepolia → Arc_Testnet`.

But there is a limitation that causes a real bug:

| Chain | Source (Standard) | Source (Fast) | Forwarding |
|---|---|---|---|
| **Arc Testnet** | ✅ | ❌ | ✅ |
| **Avalanche (Fuji)** | ✅ | ❌ | ✅ |
| **Polygon PoS (Amoy)** | ✅ | ❌ | ✅ |
| Base / Ethereum / Arbitrum / OP | ✅ | ✅ | ✅ |

`transferSpeed` **defaults to `FAST`**. A chain that only supports Standard will **FAIL** when asked
for FAST — the Quote API error `PRE_FINALITY_UNAVAILABLE`, usually surfaced as **HTTP 422**.

### 🔴 The bug we found

`app-kit-bridge/entry.ts` → `bridge()` **never set `transferSpeed`**. And 2 of the 6 source
chains in `balance.jsx` — **`Avalanche Fuji`** and **`Polygon Amoy`** — are **Standard-only**.

→ **Bridging from those two chains always failed**, and it failed on Circle's side (422), not in our
code, which makes it easy to misread as "the bridge just isn't working yet".

**Fix:** `standardOnly: true` in `BRIDGE_SOURCE_CHAINS`, then send `transferSpeed: 'SLOW'` for those
chains — `undefined` for the rest so FAST stays the default.

⚠️ **`entry.ts` is bundled** into `public/app-kit-bridge.js`. After editing it you **MUST** run
`npm run build:app-kit-bridge`, or the change never reaches the browser.

---

## 1c. "Paying with USDC from another chain" — the reality is uneven

This is a deeper question than just "turn on CCTP", and the answer **differs per user type**.

### The bridge (CCTP) needs an **external wallet**, not a UCW

`app-kit-bridge/entry.ts` → `eip1193()` reads `window.ethereum`:

> `throw new Error("No EVM wallet detected — connect MetaMask first")`

So the bridge is **EIP-1193**. Which means:

| User type | Can bridge? |
|---|---|
| **External wallet** (MetaMask, etc.) | ✅ Yes |
| **UCW / email login** | ❌ **No** — there is no EIP-1193 provider |

### And the UCW only exists on Arc

`lib/circle/ucw-user.ts` lines 196 & 332: `blockchains: ["ARC-TESTNET"]`.

→ An email-login user **has no address on Base Sepolia / Ethereum Sepolia / etc.** So they can not
only not *bridge* — they **cannot even receive** USDC on another chain.

> Note: `lib/circle/gateway-eoa.ts` (the older, now-deprecated Gateway SDK) **did** create wallets on
> `["ARC-TESTNET", "BASE-SEPOLIA", "AVAX-FUJI"]`. So multi-chain UCW has **precedent** — it is not
> a new idea.

### So, where things stand

| | Status |
|---|---|
| External wallet, USDC on another chain | ✅ **Works** — bridge on the Wallet page → USDC lands on Arc → pay |
| Email login (UCW), USDC on another chain | ❌ **No path yet** |

### ⚠️ "Mainnet is just a config swap" — that is not accurate

What *is* just a config swap: `APP_KIT_ENV`, the key, and the chain list. But the **UCW gap above
persists on mainnet** — changing networks does not give a UCW an address on another chain.

### 📌 Verified CCTP facts (from `@circle-fin/provider-cctp-v2`)

Extracted directly from the installed SDK, not from memory:

| | Arc Testnet | Arc Mainnet |
|---|---|---|
| CCTP **domain** | **26** | **26** |
| chainId | 5042002 | — |
| RPC | `https://rpc.testnet.arc.network/` | — |
| USDC (ERC-20, 6 decimals) | `0x3600000000000000000000000000000000000000` | — |
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | — |
| MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | — |
| `cctp.forwarderSupported` | `{ source: false, destination: true }` | `{ source: false, destination: true }` |
| `gateway.forwarderSupported` | `{ source: true, destination: true }` | `{ source: true, destination: true }` |

⚠️ **Arc uses native USDC with 18 decimals for gas, but its ERC-20 USDC contract uses 6 decimals.**
Those are two different numbers and are easy to confuse when writing `parseUnits`.

Source chains (all Standard-Transfer-only, all `cctp.forwarderSupported.source: false`):

| Chain | CCTP domain | chainId | USDC |
|---|---|---|---|
| Ethereum Sepolia | 0 | 11155111 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Avalanche Fuji | 1 | 43113 | `0x5425890298aed601595a70ab815c96711a31bc65` |
| Arbitrum Sepolia | 3 | 421614 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| Base Sepolia | 6 | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

### 🧱 The wall you cannot work around: **gas on the source chain**

This is the most important conclusion and the easiest one to miss. **Every** cross-chain route —
raw CCTP, Bridge Kit, Swap Kit, **and** Gateway unified balance — needs a
**transaction on the source chain**. A transaction needs **gas on the source chain**.

So for a UCW / email-login user:

| Requirement | Why it is a problem |
|---|---|
| Signing on the source chain | The UCW only exists on Arc → **multi-chain UCW** has to come first |
| **Gas on the source chain** | A UCW user has no ETH/AVAX. You need **Circle Gas Station** (testnet: free when enabled) or to sponsor it yourself (mainnet: **you pay per user**) |
| Minting on Arc | CCTP: `receiveMessage` is permissionless → we can relay it with a DCW. Gateway: `spend` is also a separate tx |

**Which means:** "turn on CCTP" is not a config flip. What has to be built is **3 layers**
(multi-chain UCW → PIN-signed burn → mint relay on Arc), and the gas layer
needs a product decision, not just code.

### 💡 Why this matters less than it looks (mainnet specifically)

On **mainnet**, Circle Mint and large exchanges (Coinbase, etc.) **can withdraw USDC straight to
Arc** — Arc is Circle's own chain. So a buyer can route their USDC to Arc **before** it ever
reaches us, with no bridge at all.

→ The in-app bridge is a **convenience, not a requirement.** The only thing genuinely mandatory is a
**clear Arc address to deposit to** (which already exists — it is the user's UCW address).

### Two paths

**A. Cheap (done 2026-10-07)** — improve *reach* for users who can already bridge:
- Fix `transferSpeed` (2 of 6 chains always failed — see §1b)
- In the WL buy modal: when the balance is short, show the way out to the Wallet page (it used to be a **dead end**)

**B. ✅ BUILT (2026-10-10)** — so email-login users can do it too.

Behind the flag **`CROSS_CHAIN_PAY=1`** (off by default, so it can ship dark).

| # | Step | What it does | Files |
|---|---|---|---|
| B1 | **Multi-chain UCW** | Wallets on the source chains, **diff-based** — an existing user only gets the chains they are missing | `lib/cctp/wallets.ts`, `ucw-provisioning.ts` (`missingChains`) |
| B2 | **PIN-signed burn** | `approve` + `depositForBurn` as CONTRACT_EXECUTION challenges | `lib/cctp/burn.ts`, `lib/ucw/contract-execution-challenge.ts` |
| B3 | **Mint relay on Arc** | `receiveMessage(attestation)` — permissionless, run by our DCW | `lib/cctp/relay.ts`, `lib/cctp/attestation.ts` |
| B3' | *Forwarding Service* | ❌ **Unusable** — `cctp.forwarderSupported.source = false` on every source chain | — |
| B4 | **Gas** | ⚠️ **Still a product blocker.** The UI checks the native balance and says exactly what is needed. Testnet: Circle Gas Station / faucet. Mainnet: we sponsor it, or the user tops up | `readSourceBalances()` |

**Full flow (2 signatures + 1 relay):**
```
POST /api/wallet/cross-chain  {action:'prepare'} → row PREPARED + approve challenge
  → user signs with PIN → {action:'confirm', step:'approve'} → APPROVED + burn challenge
  → user signs with PIN → {action:'confirm', step:'burn'}    → BURNED
  → cron /api/admin/cross-chain/relay (every 5 minutes)
      → Iris attestation (~15 minutes) → receiveMessage on Arc → MINTED
```

**Design decisions that matter:**
- **The row is written BEFORE asking for a signature.** If the user closes the tab between approve and
  burn, their USDC is already burned and we would have no record of it at all. This ordering prevents that.
- **The `txHash` from the browser is not trusted.** It is verified on-chain first (`verifySourceTx`):
  successful receipt, `to` = the right contract, `from` = the user's wallet.
- **We do not decode the CCTP event.** CCTP v2 added fields over v1 — the same bug pattern as reading a
  17-field struct through a 10-field ABI. What we use instead: the receipt shape plus **Iris** (which
  cannot be faked, because it only emits for a burn its validators actually observed).
- **`receiveMessage` is permissionless** → the relay is about latency, **not custody**. If the cron dies,
  the user (or anyone) can still finish it themselves with the same attestation.
- **Mint goes to the user's own Arc address** (`mintRecipient`), never to a platform account.
- **The allowance is the exact amount**, not unlimited.

**Also built (2026-10-11):**
- **Manual retry** — `POST /api/wallet/cross-chain {action:'retry'}` + a "Check" button on each
  unfinished bridge. The cron runs every 5 minutes, but the user is sitting there watching USDC that
  has already left their source wallet; waiting on a scheduler is not an answer. Safe to expose
  because the amount and recipient are fixed inside Circle's signed message, so a retry can only ever
  deliver the user's own funds to their own address.
- **MINTED notification** — in-app + best-effort email (`notifyUser`). Without it the USDC simply
  appears: the burn is visible on the source chain, so from the user's side the money had vanished.
- **ID / ZH / RU translations** for all 36 new keys, guarded by a test in
  `__tests__/lib/i18n-integrity.test.ts` (a key missing from a translated block would otherwise
  silently render in English, which no other check catches).

The alternative route (**Gateway unified balance**) is not used: it needs a source-chain tx + gas just
the same, and the existing `transferUnifiedBalanceCircle` uses `circleDeveloperSdk.signTypedData`
→ which only works for **DCW**, not UCW.

⚠️ **Testnet still cannot be tested end-to-end without gas on the source chain.** On mainnet, exchanges /
Circle Mint can withdraw USDC **straight to Arc**, so this route remains more of a convenience.

---

## 2. Off-ramp: Circle App Kit **DOES NOT HAVE ONE**
This is the key finding. App Kit's capabilities are only:

> Send · Bridge · Swap · Unified Balance · **Onramp** · Earn · Borrow

**There is no Offramp.** So USDC → fiat **cannot** go through the same route as on-ramp.

---

## 3. ❌ Do not become the off-ramp yourself — here is why

If the platform is what converts user USDC into fiat, the platform **becomes a money transmitter**.
The consequences:

- **A licence per jurisdiction** — not one licence, but one per state/country
- **A bank in every jurisdiction** — exactly the problem you raised: your bank is Indonesia-only
- **KYC/AML becomes your liability** — not a vendor's
- **Chargebacks & fraud become your risk**

For a solo developer this is **game over**. And more importantly: **you do not need it.**

### 💡 Because your users can already cash out themselves

Your target market is people who **already trade OTC on Telegram**. They **already know** how to
cash out USDC locally — that is precisely their expertise. The platform does not need to solve a
problem **its own users have already solved.**

And look at your own product: **the fiat leg is already outside the platform** (`fiat_leg` — the buyer
transfers directly to the seller's bank). So fiat **genuinely never needs to pass through the platform.**
That is not a limitation — that is **the correct design**.

### So the flow is:

```
FIAT IN    buyer → [Circle onramp widget] → USDC on Arc → escrow
FIAT OUT   seller → withdraw USDC from the platform → their own exchange/wallet → local cash out
```

The platform **never touches fiat at all.** Good for you (no licensing burden) and
good for the user (they use a route they already trust).

### If you later do want an off-ramp
**Circle Mint** — a business account, KYB, mint/redeem USDC↔fiat over wire. That is the **licensed**
route. But it is a **business** decision (it needs an entity + KYB), not a technical one. **Not now.**

---

## 4. Recommendation

| | Action | Why |
|---|---|---|
| **On-ramp** | ✅ **Turn it on** — complete KYB in the Circle Console | The infrastructure is already there. Zero new vendors. Works globally. |
| **Off-ramp** | ❌ **Do not build it.** Point sellers at USDC withdrawal instead | The licensing burden is not worth it. Users can already do it themselves. |
| **Dead `fiat` branch** | 🟡 Optional: use it for **on-ramp at the checkout point** | The on-ramp infrastructure already exists — just mount the widget in the checkout modal. Better UX: "pay by card" without topping up first |
| **Legacy fiat withdraw UI** | ✅ Leave it hidden (`!custodialHidden`) | It is already disabled in on-chain mode |

**One concrete step you can take right now: KYB in the Circle Console.** After that your on-ramp
goes live for global users — no Stripe, no bank, no licence.
