# DoraHacks project page — copy-paste sheet (English)

Final English copy for the SlimeMarket project page. Written to be pasted field by field, no
editing needed. Everything factual here is verifiable on Arc mainnet — hashes in §4.

---

## How to use this file

1. **Images** — in the Description editor, upload and insert:
   - `docs/assets/escrow-lifecycle-dark.png` (use this one — the page is dark)
   - `docs/assets/escrow-lifecycle-light.png` (fallback if the theme changes)
   Insert it right after the "How it works" heading, before the state table.
2. **Text** — paste §2 into the Description box. It is plain Markdown and renders as-is.
3. **Fields** — §1 goes into the short fields, §3 into stack/tags, §4 into any "proof" field.
4. Replace the two `TODO` markers (video, builder profile) before saving.

---

## 1. Short fields

**Project name**

```
SlimeMarket
```

**Tagline (one line, ≤ 90 chars)**

```
Trustless OTC escrow on Arc — the middleman is a smart contract.
```

**Short description (≤ 300 chars)**

```
SlimeMarket replaces the human escrow agent in high-value digital-asset trades with a smart
contract. Buyer funds and seller fraud collateral are locked in USDC on Arc, with two independent
deadlines and permissionless timeout settlement. Live on Arc mainnet.
```

**Links**

| Field | Value |
|---|---|
| Website / live app | `https://slimemarket.app` |
| GitHub | `https://github.com/SlimeMarket/slimemarket` |
| Demo video | `TODO — record per §6 of docs/DORAHACKS_SUBMISSION.md` |
| X / Farcaster | `TODO — your public builder profile` |
| Contract | `0xfe76c63289dd8b5693277df261e4938bd8779d28` |
| Example transaction | `0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c` |

---

## 2. Description — paste this into the Description box

```markdown
## The problem

A large share of high-value digital-asset trading never touches an exchange. Whitelist spots,
wallet handovers, mint services, airdrop-eligible accounts — they trade in Telegram DMs, and they
trade through a **human escrow agent**: someone who holds the money and decides who is right when a
deal goes wrong.

That model has three structural costs:

- **Counterparty risk sits with one person.** The agent can vanish, take a side, or simply be wrong.
  There is no appeal.
- **It caps deal size.** Nobody escrows $5,000 through a stranger on Telegram.
- **It is slow and manual.** Settlement waits for someone to be awake.

## What SlimeMarket does

SlimeMarket moves that exact flow on-chain. The middleman becomes a contract.

- The buyer's payment and the seller's **fraud collateral** are locked in `MarketEscrow.sol`.
- The seller marks delivery, the buyer confirms. If the buyer goes silent past the confirmation
  deadline, the seller is paid automatically.
- If either side disputes, the platform admin acts as **arbitrator only** — never as custodian. The
  money never sits with a human.
- On a fraud ruling the seller's collateral is **slashed to the buyer**, so the collateral is real
  insurance rather than decoration.

## How it works

*[insert docs/assets/escrow-lifecycle-dark.png here]*

| From | Trigger | To | Who can call it |
|---|---|---|---|
| WAITING | buyer funds the order | ESCROW | buyer, or the relay operator with a signed permit |
| ESCROW | seller marks delivered | DELIVERED | seller |
| DELIVERED | buyer confirms | COMPLETED — released to seller | buyer |
| DELIVERED | confirmation deadline passes | COMPLETED — seller paid | **anyone** |
| ESCROW | delivery deadline passes | CANCELLED — buyer refunded | **anyone** |
| ESCROW / DELIVERED | either party flags a problem | DISPUTED | buyer or seller |
| DISPUTED | admin arbitrates | RELEASED / REFUNDED / SLASHED | platform admin |
| DISPUTED | 30 days with no ruling | CANCELLED — buyer wins by default | **anyone** |

### Three decisions that matter

**Two independent clocks, not one.** `deliveryDeadline` is set at funding; `confirmDeadline` starts
when the seller marks delivered. Both are per-deal and clamped to `[1 hour, 365 days]`. A whitelist
spot ships in minutes; an airdrop-eligible wallet may only pay out months later — one fixed timeout
would be wrong for both. Splitting the clocks also removes the "whoever calls first wins" race.

**Funds cannot be stranded.** `releaseEscrowAfterTimeout` and `refundEscrowAfterTimeout` are
permissionless: once the relevant clock has passed, *anyone* can settle. A vanished operator cannot
freeze a deal. A 30-day dispute backstop means the buyer wins if nobody arbitrates.

**Money math never touches floats.** Every amount is `bigint` micro-USDC (6 decimals) from the API
boundary to the contract call.

## Why Arc

The escrow settles in USDC, so the chain had to treat USDC as a first-class citizen:

- **USDC is the native gas token.** No faucet, no second token, no "you need gas to move your
  money". For users coming from Telegram rather than crypto, a balance that is also gas removes an
  entire onboarding step.
- **Sub-second deterministic finality.** Escrow enforces two clocks. On a chain where a transaction
  can sit for minutes, the clock you enforce is not the clock the user experiences.
- **Circle-native rails.** User-Controlled Wallets (email OTP login, PIN-signed challenges), USDC
  and Gateway share one identity and one balance model across funding, swapping, bridging and
  settlement.

## What is live today

| Piece | Status |
|---|---|
| `MarketEscrow.sol` on Arc mainnet (`0xfe76…9d28`) | **Live** — 4 orders settled end-to-end |
| Marketplace checkout — external wallet (EIP-2612 permit) and Circle UCW | **Live** |
| Order lifecycle: fund, deliver, confirm, release, refund | **Live** |
| Seller center, stock and sold-out state, buyer reviews, wallet, bridge and swap | **Live** |
| OTC deal flow with seller collateral and disputes | Contract path implemented and tested; UI gated behind a "coming soon" flag |

## On-chain proof

Contract `0xfe76c63289dd8b5693277df261e4938bd8779d28` · USDC `0x3600…0000` (6 dp) · Arc mainnet,
chain ID `5042`.

Four marketplace orders opened and settled end-to-end. Each order produced two transactions — one
funding the escrow (`OrderCreated`), one releasing funds to the seller (`OrderReleased`). Every
transaction returned `status = 1`.

| # | Step | Transaction |
|---|---|---|
| 1 | Order 1 funded — `OrderCreated` | [`0x3cee387b…c0547e`](https://explorer.arc.io/tx/0x3cee387bd946875067a0418b614b0437a833ad2d6832fa751b39008e1ec0547e) |
| 2 | Order 1 released — `OrderReleased` | [`0x6f4539e6…5830cad`](https://explorer.arc.io/tx/0x6f4539e614099affa33a327c84c6132f2019ed62ab6dd46c8c6b3f35f5830cad) |
| 3 | Order 2 funded (external wallet, permit relayed) | [`0xb35c3fac…0ea5c`](https://explorer.arc.io/tx/0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c) |
| 4 | Order 2 released | [`0x99546836…34b877`](https://explorer.arc.io/tx/0x995468369786f086f8052dff04c738057700c40df8a9543495fe42cd1a34b877) |
| 5 | Order 3 funded | [`0x07a4ed6a…5c6b4d`](https://explorer.arc.io/tx/0x07a4ed6a1094bbf162b8f380a28405c79b38aa531c0c77a4e3e74144425c6b4d) |
| 6 | Order 3 released | [`0x9ee4f88c…b7fb0eb4`](https://explorer.arc.io/tx/0x9ee4f88ced1c4c13bcfd73a48147cd63540716dc6a7e859f3291e836b7fb0eb4) |
| 7 | Order 4 funded | [`0x2c1b7c39…9774607`](https://explorer.arc.io/tx/0x2c1b7c396338592b1c73ccc20f0eadee42be9e3339bf89b44d29ad6189774607) |
| 8 | Order 4 released | [`0x9387cbfe…4b8b30`](https://explorer.arc.io/tx/0x9387cbfec1d60e74b9f13e8c7f1c66015d18ec829f45df6cb1f9aeaa3f4b8b30) |
| 9 | Circle UCW (email-OTP wallet) sends USDC out — no platform key involved | [`0x83d285c8…3a90e`](https://explorer.arc.io/tx/0x83d285c8522f5afe17023047216f43ebe542212a96303f5670c1601d2b13a90e) |

**0.72 USDC moved through escrow across 9 mainnet transactions, all successful.** The values are
deliberately small: this is a live production deployment, not a funded demo, and the escrow is not
audited.

Re-check any hash yourself — no login, no API key:

```bash
curl -s https://rpc.mainnet.arc.io -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt",
       "params":["0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c"]}'
```

## What's next

1. Ship the OTC deal UI — collateral, disputes and timeout escapes. The contract path is already tested.
2. Reputation that travels with the wallet, not with the account.
3. Multi-stablecoin settlement on the same escrow.
4. Operator tooling so other marketplaces can run their own escrow instance on this contract.

## Built with

Solidity 0.8 · Hardhat · OpenZeppelin · Next.js 15 · React 19 · Node.js 22 · Supabase Postgres ·
Circle User-Controlled Wallets · Circle Developer-Controlled Wallets · CCTP · viem · Vitest ·
Playwright

---

Full source: [github.com/SlimeMarket/slimemarket](https://github.com/SlimeMarket/slimemarket) ·
Decoded calldata and per-order mapping: [`docs/MAINNET_VERIFICATION.md`](https://github.com/SlimeMarket/slimemarket/blob/main/docs/MAINNET_VERIFICATION.md)
```

---

## 3. Stack / tags

```
Solidity, Arc, USDC, Escrow, Marketplace, Next.js, React, Node.js, PostgreSQL, Supabase,
Circle Wallets, CCTP, viem, Hardhat, OpenZeppelin, Vitest, Playwright
```

---

## 4. Proof fields (contract / example transaction)

| Field | Value |
|---|---|
| Chain | Arc mainnet — chain ID `5042` (`0x13b2`) |
| RPC | `https://rpc.mainnet.arc.io` |
| Contract | `0xfe76c63289dd8b5693277df261e4938bd8779d28` |
| USDC (ERC-20, 6 dp) | `0x3600000000000000000000000000000000000000` |
| Example transaction | `0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c` |
| Explorer | `https://explorer.arc.io/tx/0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c` |
| Live app | `https://slimemarket.app` |

---

## 5. Short answers for the "Questions" section

**What is it, in one sentence?**
A peer-to-peer OTC marketplace where a smart contract replaces the human escrow agent.

**What is on-chain and what is off-chain?**
Money movement, collateral, deadlines and settlement outcomes are on-chain in `MarketEscrow.sol`.
Product listings, credentials for instant delivery, chat and reviews are off-chain in Postgres —
they do not need trustless guarantees, and putting them on-chain would only add cost.

**How do you make money?**
A 2% buyer fee. No base fee, no separate gas charge to the buyer.

**Is it audited?**
No. The contract has 106 Hardhat tests plus a 23-step on-chain lifecycle suite, and live volume is
intentionally small. An audit is on the roadmap before scaling volume.

**Why not just use an existing escrow?**
Existing escrow products settle in a volatile gas token and treat disputes as a support ticket.
SlimeMarket settles in USDC with the gas paid in the same asset, and the dispute path is a contract
function with a hard 30-day backstop.

---

## 6. Pre-save checklist

- [ ] Diagram image uploaded and inserted after "How it works"
- [ ] `TODO` video link replaced
- [ ] `TODO` builder profile replaced
- [ ] Contract + example tx pasted into the dedicated fields
- [ ] 4 screenshots attached (explore, product, checkout, seller orders)
- [ ] Every `explorer.arc.io` link opens and shows `Success`
- [ ] Team line filled (name or pseudonym)
