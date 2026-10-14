# Gap Audit: Codebase vs Circle Best Practice

> Generated 2026-08-11 via `mcp__circle__search_circle_documentation` + `get_circle_product_summary` + `mcp__arc-docs__search_arc_docs`.

## Summary

| Area | Status | Gaps | Severity |
|------|--------|------|----------|
| Onboarding & PIN | ✅ Match | SMTP OTP delivery not wired for prod | ⚠️ Medium |
| Challenge model | ✅ Match | `txId=challengeId` design (documented) | ℹ️ Low |
| Security trade-offs | ⚠️ Documented | pin-gate fail-open, pin-reset crypto (fixed) | ℹ️ Low |
| Hybrid wallet model | ✅ Match | Bridge Kit doesn't support Circle wallets | ℹ️ Constraint |
| arc-docs cross-check | ✅ Consistent | — | ✅ |

---

## 1.1 Onboarding & PIN ✅

### Circle docs reference
- [create-user-wallets-with-pin](https://developers.circle.com/wallets/user-controlled/create-user-wallets-with-pin)
- [create-user-wallets-with-email](https://developers.circle.com/wallets/user-controlled/create-user-wallets-with-email)
- [authentication-methods](https://developers.circle.com/wallets/user-controlled/authentication-methods)
- [reset-account-pin](https://developers.circle.com/wallets/user-controlled/reset-account-pin)

### Codebase match
| Circle flow | Codebase | Status |
|-------------|----------|--------|
| `createUserPinWithWallets` (PIN + wallet in one hosted UI) | `lib/circle/ucw-user.ts` | ✅ |
| `createUserPin` (PIN-only for legacy accounts, wallet exists) | `lib/circle/ucw-user.ts` → `decideProvisioning()` "pin-only-challenge" branch | ✅ |
| `createWallet` (wallet only, PIN already set) | `lib/circle/ucw-user.ts` → "wallet-only-challenge" branch | ✅ |
| `restoreUserPin` (security questions recovery) | `app/api/my/pin-restore/route.ts` | ✅ |
| Security questions only at signup/recovery, NOT per-transaction | ✅ — only at onboarding + RESTORE_PIN | ✅ |
| Error 155106 "user already initialized" → skip PIN setup | `decideProvisioning()` → "done" branch | ✅ |

### Gap: SMTP OTP delivery ⚠️ Medium
**Circle docs**: OTP is generated & validated by Circle, but **delivery rides on YOUR SMTP provider**. Circle Console (Wallets > User Controlled > Configurator > Email) stores SMTP credentials encrypted. Email template must contain `{{ email.otp }}` placeholder.

**Codebase**: `app/api/auth/email-otp/route.ts` calls Circle `/v1/w3s/users/email/token` which triggers OTP email. Codebase assumes Mailtrap for dev. Prod SMTP not wired.

**Fix**: WS3.1 completed — `app/api/my/pin-reset-request/route.ts` now wires Nodemailer with `SMTP_HOST/PORT/USER/PASS` env vars, fallback `console.log` for localhost.

**Pre-VPS action**: Configure SMTP credentials in Circle Console + `.env.local`. Test OTP email delivery.

---

## 1.2 Challenge Model ✅

### Circle docs reference
- [sdk-architecture](https://developers.circle.com/wallets/user-controlled/sdk-architecture)
- [send-an-outbound-transfer-or-execute-contract](https://developers.circle.com/wallets/user-controlled/send-an-outbound-transfer-or-execute-contract)
- SDK enum `ExecuteResultType`: `SET_PIN`, `RESTORE_PIN`, `CREATE_WALLET`, `CREATE_TRANSACTION`, `CONTRACT_EXECUTION`, `SIGN_TYPEDDATA`, etc.

### Codebase match
| Circle challenge type | Codebase use | Status |
|----------------------|-------------|--------|
| `SET_PIN` + `CREATE_WALLET` | `createUserPinWithWallets` (onboarding) | ✅ |
| `RESTORE_PIN` | `restoreUserPin` (PIN recovery) | ✅ |
| `CONTRACT_EXECUTION` | `createUserTransactionContractExecutionChallenge` — checkout approve, WL collateral | ✅ |
| `CREATE_TRANSACTION` (TRANSFER) | `createTransaction` — withdraw/send USDC | ✅ |
| Backend creates `challengeId` → FE `sdk.execute(challengeId)` → hosted UI PIN → on-chain | `lib/ucw/contract-execution-challenge.ts` + `lib/ucw/transfer-challenge.ts` | ✅ |

### Documented design: `txId = challengeId` ℹ️ Low
**Codebase**: `lib/ucw/contract-execution-challenge.ts` line 77 returns `txId: challengeId` because Circle's contract-execution challenge response only contains `challengeId` — the actual Circle tx id + on-chain txHash appear AFTER the user approves via W3SSdk.execute in the browser.

**Impact**: Confirm endpoints MUST verify via Arc RPC (`getTransactionReceipt`) instead of polling Circle's tx API. `ucw-settle/route.ts` already does this correctly.

**Status**: Intentional design, not a bug. Documented for future agents.

---

## 1.3 Security Trade-offs ⚠️

### pin-gate.ts fail-open ℹ️ Low (user-approved)
**Codebase**: `lib/wallet/pin-gate.ts` line 48-50 — if `getCircleUserStatus()` throws (network/outage), returns `{ ok: true }` (fail-open). Trade-off: don't brick checkout on a transient Circle outage; the challenge creation itself will surface the real error.

**User decision**: Keep fail-open (confirmed 2026-08-11).

**Pre-VPS recommendation**: Hook up alerting/monitoring (Sentry already in deps) to log fail-open events. Consider retry policy in FE.

### pin-reset crypto-secure ✅ Fixed
**Before**: `Math.random()` for reset code (not cryptographically secure), stored plaintext in `temp_reset_codes`, SMTP commented out.

**After (WS3.1)**: `crypto.randomInt(100000, 1000000)` (secure), SHA-256 + salt hashing, Nodemailer SMTP wiring with fallback.

---

## 1.4 Hybrid Wallet Model (UCW + DCW + EOA) ✅

### Circle docs reference
- `get_circle_product_summary("user-controlled-wallets")`: MPC wallets, users control keys, 3 auth methods (Email/Social/PIN).
- `get_circle_product_summary("cctp")`: Bridge Kit does NOT yet support Circle wallets (DCW/UCW/MSCA).

### Codebase match
| Concept | Codebase | Status |
|---------|----------|--------|
| UCW for end-users (non-custodial, PIN-secured) | `lib/circle/ucw-client.ts` | ✅ |
| DCW for platform treasury/relayer (custodial) | `lib/circle/client.ts` | ✅ |
| `send-mode.ts` 3-branch (legacy/ucw-challenge/blocked) | `lib/wallet/send-mode.ts` | ✅ |
| EOA permit path (gasless, EIP-2612) | `lib/order/permit-checkout.ts`, `lib/wl/eoa.ts` | ✅ |

### Constraint: Bridge Kit & Circle wallets ℹ️
Circle CCTP product summary explicitly states: **"The Bridge Kit does not yet support Circle wallets (Developer-Controlled Wallets, User-Controlled Wallets, and Modular Wallets (MSCA))."**

**Impact**: CCTP cross-chain bridging (M7 scope, skipped per user) cannot use UCW/DCW signatures directly. Options for M7:
- (A) User bridges via external EOA wallet (MetaMask) on source chain → receive at UCW Arc address
- (B) Platform DCW treasury bridges (custodial)
- (C) Gateway/Unified Balance (separate product, needs depositor signing)

---

## 1.5 arc-docs Cross-check ✅

### Source
`mcp__arc-docs__search_arc_docs` — indexes docs.arc.io (Arc network documentation).

### Verification
| Arc doc pattern | Codebase | Status |
|----------------|----------|--------|
| `releaseOrder` escrow pattern | `lib/contracts/escrow-client.ts::releaseOrderOnChain` | ✅ |
| `releaseEscrow` / `refundEscrow` (WL) | `lib/contracts/escrow-client.ts` | ✅ |
| Native USDC transfer (recommended withdrawal path) | `lib/contracts/escrow-client.ts::sendUsdc` | ✅ |
| E-commerce escrow (programmable escrow) | `contracts/MarketEscrow.sol` | ✅ |
| ERC-8183 job pattern (agentic commerce) | Not applicable (marketplace, not agentic) | N/A |

**No gaps found.** Codebase escrow patterns are consistent with Arc docs.

---

## Conclusion

The codebase aligns with Circle best practices. Remaining items:
1. **SMTP OTP delivery** — configure in Circle Console + `.env.local` before VPS (WS3.1 code ready).
2. **pin-gate fail-open** — keep (user-approved), add alerting pre-VPS.
3. **CCTP M7** — Bridge Kit constraint noted; defer to post-VPS.
