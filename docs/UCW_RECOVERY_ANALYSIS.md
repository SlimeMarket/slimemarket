# Analysis: UCW Recovery — when a user loses access to their email

> 2026-09-26 · User's question: *"both seller and buyer users use UCW. Say a user can't access the email they signed up with, what then? Their money is still in UCW, they have to log in first to withdraw. As far as I know UCW can't export a private key. How does recovery work?"*

**Short answer: your concern is valid, and this is a real hole — but there are 3 layers, and 2 of them can be fixed.**

---

## 1. What Circle actually supports

From Circle's official documentation (verified via the `circle` MCP + the docs pages):

| Scenario | Can recover? | How |
|---|---|---|
| Forgot PIN, still remember security questions | ✅ | `restoreUserPin` → challenge `RESTORE_PIN` → answer the questions → set a new PIN |
| Know the PIN, want to change it | ✅ | `updateUserPin` → challenge `CHANGE_PIN` |
| Forgot PIN **and** security questions | ❌ | **Permanently locked.** Circle: *"Circle has no way to recover an account when both the PIN and the security answers are lost."* |
| Security questions were never set | ❌ | No recovery path (error `155111`) |
| Lost access to email | ⚠️ | Normal login requires an email OTP — but see §3 |

### Direct quotes from Circle

> **Caution**: If a user loses both their PIN code and the answers to their Security Questions, they will be **permanently locked out** of their account, losing access to all of their wallets and assets.

> **No additional parties can help users regain access** to a user-controlled wallet if their PIN code is lost and they cannot remember the answers to their security questions.

> Security questions **can be set only once during sign-up and can't be reset** (error `155108`).

### Relevant error codes

| Code | Meaning |
|---|---|
| `155104` | userToken expired (60 minutes) |
| `155108` | Security questions already set — **cannot be changed** |
| `155111` | Security questions not set → recovery unavailable |
| `155115` | Wrong security question answers |
| `155120` | 3× wrong answers → recovery locked for 30 minutes |
| `155107` | PIN already set |

**Hard fact: UCW cannot export a private key.** This is by design — the key is MPC-split, Circle
holds one share, the user holds one share. There is no "seed phrase" to back up.

---

## 2. Three lockout vectors (and how they differ)

These are often lumped together even though they need different handling:

### A. Lost access to email
- Normal login: `POST /users/email/token` → OTP sent to email → user enters OTP → gets `userToken` + `deviceToken` + `deviceEncryptionKey`.
- Email dead = can't get an OTP = can't log in.
- **But the money isn't lost** — it's still on-chain in the user's UCW wallet.
- ⚠️ Circle doesn't expose a "change email" endpoint for UCW. The `userId` is created against the email at signup. So the user's Circle identity is bound to that email.

### B. Forgot PIN + forgot security questions
- **This is the one nobody can fix.** Circle is explicit.
- The only mitigation: prevention (see §5).

### C. Switching device / clearing browser storage
- `deviceToken` + `deviceEncryptionKey` are **only** returned to the client at login (`app/api/auth/email-otp/route.ts:73-74`) — not stored server-side.
- That means: lost device = must log in again (requires email). Not a permanent loss as long as the email is still alive.

---

## 3. What's already built in this repo

The repo **already has** a recovery system — and the design is good. It's in:

| File | Function |
|---|---|
| `supabase/migrations/0065_recovery_wallets.sql` | `recovery_wallets` + `auth_nonces` tables |
| `lib/auth/recovery.ts` | Single-use nonce, EIP-191 signature verify, EOA registry |
| `app/api/auth/recovery/challenge/route.ts` | Issue nonce |
| `app/api/auth/recovery/verify/route.ts` | Exchange signature → session |
| `app/api/me/recovery-wallet/route.ts` | Link/unlink EOA |
| `__tests__/lib/wallet-recovery.test.ts` | Tests |

**How it works:**
1. The user (still logged in) links an external EOA — MetaMask/Coinbase — to their account.
2. If the email dies, the user opens the recovery page, the server issues a nonce, and the user **signs a message with that EOA** (EIP-191, domain-bound + nonce-bound, single-use).
3. The server verifies → sets the same session cookie as a normal login.

**But — and this is the gap — that session is DATA-ONLY.** The code is honest about this:

```ts
// app/api/auth/recovery/verify/route.ts
recovered: true,
// UCW money actions still need email-OTP; the FE surfaces this limitation.
recoveryLimitation:
  "Recovery session restores access to your orders, store and history. Actions that sign with your Slime Wallet still require a normal email-code login.",
```

And the reason is documented in migration 0065:

> **WHY EOA ONLY:** Circle UCW keys are MPC-split and only Circle can sign; a Circle signing session itself comes from an email OTP, so a UCW holder who lost their inbox cannot prove identity with the UCW wallet.

**The consequence: a user who loses their email can view orders & history, BUT CANNOT withdraw
their money.** The money stays safe on-chain, but it's inaccessible.

---

## 4. ⚠️ Important correction to an assumption in the code

The claim *"a Circle signing session itself comes from an email OTP"* is **not entirely true** —
and this is good news.

Circle has **two** ways to obtain a `userToken`:

| Method | Auth | Needs the user's email? |
|---|---|---|
| `POST /users/email/token` | OTP to the user's email | ✅ Yes |
| `createUserToken({ userId })` | **server-side API key** | ❌ **No** |

`createUserToken` is **server-side, authenticated with our API key**, not the user's email. And
Circle itself uses this as **step 1 of their official recovery flow**:

```js
// Circle docs — "Recover an account", Step 1
const response = await client.createUserToken({ userId });
const userToken = response.data.userToken;
const encryptionKey = response.data.encryptionKey;   // ← SDK needs this
```

So the server **can** issue a signing session without the user's email. What the server can't do is
**complete** the challenge — that still requires the user's PIN or security question answers.

**That means:** the "money actions need email OTP" limitation is most likely **our design choice**,
not a hard Circle limitation. A ~30-minute spike is needed to confirm (see §5 option 2).

---

## 5. Fix options

### Option 1 — Prevention (MANDATORY before launch, zero risk)

- [ ] **Make sure security questions are actually set at signup.** The repo uses `createUserPinWithWallets`, whose hosted UI shows the security questions — but there's **no verification** that the user actually filled them in. Add a check of `securityQuestionDetails` from `getUserStatus` after onboarding; if it's empty, prompt the user to set them.
- [ ] **Honest onboarding copy.** Say it plainly: the PIN + security question answers = the only key. If both are lost, the money is lost permanently. This is not something that should be buried in a FAQ.
- [ ] **Tell users to store the answers offline** (password manager / paper), just like a seed phrase.
- [ ] **Require linking a recovery wallet** at onboarding (not optional) — so that the Option 2 path is always available.

### Option 2 — Extend the existing recovery so it can access money (RECOMMENDED)

This builds on what's **already** built, just adding one step:

```
User loses email
  → open /recovery, sign with the linked EOA                 [ALREADY EXISTS]
  → server verifies the signature → user's identity proven   [ALREADY EXISTS]
  → server calls createUserToken({ userId })                 [NEW]
  → server calls restoreUserPin({ userToken })               [NEW]
  → client SDK: user answers security questions → new PIN    [NEW]
  → now the user has a full session → can withdraw           [NEW]
```

**Result: "lost email" changes from a loss-of-money event into a recoverable incident.**

Things to watch out for:
- The user still **must** remember the security questions → which is why Option 1 is mandatory first.
- Strict rate limiting + audit log (the `mm_audit_log` table already has a `RECOVERY_LOGIN` action; add `RECOVERY_PIN_RESTORE`).
- A spike is needed first to confirm `createUserToken` works for a user whose auth method is email OTP.

### Option 3 — Contract-level escape hatch (last-resort safety net)

Add a function in `MarketEscrow.sol` that, after a timelock (e.g. 30 days), can send funds still in
escrow to a previously registered recovery address.

- Useful for the case where the **seller disappears before release** — the funds don't get stuck forever.
- The contract already has an escape-hatch pattern (used for stalled deals), so it just needs to be extended.
- **Note:** this only rescues funds that are **still in escrow**. Funds already in the user's UCW wallet can't be touched by the contract.

### Option 4 — What CANNOT be fixed

**Forgot PIN + forgot security questions → permanently locked.** No app, no Circle, no admin can
unlock it. This is a hard MPC limitation.

The only mitigation: Option 1, and being honest with the user from the start.

---

## 6. Summary for the product decision

| Scenario | Current status | After Options 1+2 |
|---|---|---|
| Forgot PIN, remember security questions | ✅ Works (Circle flow) | ✅ Works |
| Email lost, remember PIN/questions | ⚠️ Data view only, **money can't be withdrawn** | ✅ **Can withdraw money** |
| Forgot PIN + security questions | ❌ Permanent | ❌ Permanent (unchanged) |
| Device lost, email alive | ✅ Log in again | ✅ Log in again |

**Priority:** Option 1 before launch (cheap, mandatory). Option 2 once the MVP is running (closes
the locked-money hole). Option 3 optional. Option 4 = user education, not engineering.

---

## References

- `https://developers.circle.com/wallets/user-controlled/recover-account`
- `https://developers.circle.com/wallets/user-controlled/reset-account-pin`
- `https://developers.circle.com/wallets/user-controlled/authentication-methods`
- `supabase/migrations/0065_recovery_wallets.sql` (original design comments)
- `app/api/auth/recovery/verify/route.ts`
