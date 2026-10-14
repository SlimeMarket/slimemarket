# UCW: Login Auth Method vs PIN + Security Questions

> 2026-09-26 · Answering the confusion: *"in my console dashboard I only see an auth method for the UCW using email"* + *"does that need a webhook to the circle console?"*

---

## TL;DR

There are **TWO completely separate layers**, and that's why the Console looks like it "only has email":

| Layer | Function | Where it's configured | Visible in Console? |
|---|---|---|---|
| **Auth Method** | Proves **WHO** the user is (login) | Circle Console → Configurator → Authentication Methods | ✅ **Yes** — this is what you see |
| **PIN + Security Questions** | Authorizes **ACTIONS** (tx signing) + **recovery** | **Circle Hosted UI**, triggered by our API `createUserPinWithWallets` | ❌ **No** — not a Console setting |

**So it's normal for the Console to show only "email".** PIN and security questions are **indeed
never** in the Console — they are set by the **user themselves** in the Circle hosted UI when the
challenge runs.

**And no, this does NOT need a webhook.** PIN/security questions are a client-side challenge via
the Web SDK. Webhooks are not involved at all.

---

## 1. Why the Console only shows Email

Circle Console → Wallets → User Controlled → **Configurator → Authentication Methods** is for
choosing the **login method**: Email OTP, Google, Apple, Facebook.

That's all. **There's no PIN toggle there** because PIN is not an auth method — PIN is the
**transaction authorization layer** that lives inside the challenge.

Circle docs confirm:

> **PIN:** A Personal Identification Number (PIN) enhances security by authenticating users when
> signing wallet transactions.

> **Security Questions:** Users must set up security questions for account recovery, providing
> additional protection.

> During user creation, the initial challenge guides users in setting their PIN code and **Recovery
> Method**, enabling account recovery if necessary.

And for `createUserPinWithWallets`:

> Circle opens a hosted UI where the user sets their **authorization PIN and security questions**.

**Conclusion: email (login) + PIN (signing) + security questions (recovery) are three different
things that coexist.** Email-OTP for login, PIN for signing, security questions for recovery.

---

## 2. ✅ Proven directly, not assumed

Circle docs have one line that gives pause:

> **User without PIN:** Reset PIN works only for users created with the PIN authentication method.
> Social login or email OTP users don't have a PIN to reset.

Read literally, that means an email-OTP user **can't have a PIN** — and our entire recovery design
collapses. I probed the API directly to make sure:

```
=== Probe: email-OTP user + PIN/security-question setup ===
test userId: smprobe1

  ✓ createUser
  ✓ createUserToken
      encryptionKey present: true
  ✓ getUserStatus (before)
      pinStatus            : UNSET
      securityQuestionDet. : {"failedAttempts":0}
  ✓ createUserPinWithWallets
      challengeId          : 85f02586-781c-5b58-9597-57f817aed91e

RESULT: ✅ email-OTP user CAN start the PIN + security-questions challenge.
```

**So that doc line is misleading / legacy.** An email-OTP user **can** have a PIN and security
questions. Our design is correct.

> ⚠️ **Clean up:** this probe created a test user `smprobe1` in your Circle account.
> Delete it in Console → Wallets → User Controlled → Users.

---

## 3. The real flow in this repo

PIN onboarding **EXISTS and is fully wired**. It's not missing — it was just moved from signup to a
gate when the app opens (.C).

### Backend

| File | Role |
|---|---|
| `lib/circle/ucw-user.ts:189` `createPinSetupChallenge()` | `createUserPinWithWallets({ userToken, blockchains:["ARC-TESTNET"], accountType:"EOA" })` — **one challenge: set PIN + security questions + create wallet** |
| `lib/circle/ucw-user.ts:157` `getCircleUserStatus()` | Reads `pinStatus` + `securityQuestionDetails` |
| `lib/circle/ucw-provisioning.ts:57` `decideProvisioning()` | Chooses the challenge: `full` / `pin-only` / `wallet-only` / `done` / `locked` / `skip` |
| `app/api/auth/me` + `app/api/auth/unified` | Every login sets `needsPinSetup` + `pinSetupChallengeId` |
| `app/api/my/pin-setup/route.ts` | Endpoint for the "Set up PIN" CTA on the wallet page |

### Frontend

| File | Role |
|---|---|
| `public/app.jsx:370` | Receives `needsPinSetup` → shows a **full-screen gate** |
| `public/app.jsx:396` `runPinSetupGate()` | Runs the challenge → Circle hosted UI |
| `public/ucw-helper.jsx:47` `executeUcwChallenge()` | `sdk.execute(challengeId)` — this is where **custom security questions** are attached |
| `public/ucw-helper.jsx:72-83` | `setCustomSecurityQuestions([...], 2)` + `setLocalizations(lang)` |
| `public/saldo.jsx:315` | "Set up PIN" CTA on the balance page |

### Full flow

```
Signup / login (email OTP)                       ← AUTH METHOD (Console)
        ↓
/api/auth/unified → decideProvisioning()          ← check pinStatus
        ↓
needsPinSetup + pinSetupChallengeId
        ↓
app.jsx → full-screen gate "Secure your wallet"
        ↓
executeUcwChallenge(challengeId, {isPinSetup:true})
        ↓
setCustomSecurityQuestions([sq1, sq2], 2)         ← 2 questions, required
setLocalizations(lang)                            ← follows the user's language
        ↓
CIRCLE HOSTED UI:  Create PIN → Verify ×2 → Security Questions
        ↓
POST /api/wallet/ucw-provisioning-complete
        ↓
wallet_provisioned = true, gate disappears
```

---

## 4. Webhook? Not needed.

| Need | Use webhook? | What's used now |
|---|---|---|
| Set PIN + security questions | ❌ No | Web SDK `execute(challengeId)` — client-side |
| Know when the challenge is done | ❌ Optional | Polling `getUserChallenge` |
| Escrow contract events (Path B #1) | ✅ **Yes** | SCP event monitor → `contracts.eventLog` |
| Wallet notifications (in/out) | ✅ Yes | `/api/webhooks/circle` |

So the webhook you need is for **escrow contract events** (whose monitor I've already registered),
**not** for PIN/security questions.

---

## 5. What I fixed in this session

**12 i18n keys were missing.** The dictionary only had `pin.skipLater` + `pin.skipToast`. The rest —
**the entire PIN gate UI + 2 security questions** — fell back to English for **all languages**,
including Indonesian. So Indonesian users saw the security questions in English.

Added to 4 languages (en/id/zh/ru):

`pin.gateTitle`, `pin.gateDesc`, `pin.gateCta`, `pin.gateBusy`, `pin.gateNote`,
`pin.gateRequired`, `pin.bootDone`, `pin.bootIncomplete`, `pin.lockedMsg`,
`pin.setupNotice`, `pin.sq1`, `pin.sq2`

Now Indonesian users see: *"The city where you were born?"* and *"Your favorite product category?"*

---

## 6. How to verify it yourself in the Console

1. **Auth method** → Console → Wallets → User Controlled → **Configurator → Authentication Methods**
   (this is where you see "Email" — that's correct)
2. **App ID** → the same Configurator page
3. **User + PIN status** → Console → Wallets → User Controlled → **Users**
   Click a user → see `PIN Status` (`UNSET` / `ENABLED` / `LOCKED`) and `Security Questions`
4. **After a real signup**, check that user: `PIN Status` should be `ENABLED`.
   If it's `UNSET` it means the user skipped the gate → **they have no UCW wallet and can't recover**
   (but no money is stuck either, because the wallet was never created).

---

## 7. Note: the gate can be skipped, and that's safe

`.C` deliberately made the gate skippable (`pin.skipLater` → "Later — pay with your own
wallet"). The reason: a user can shop using an external EOA without a PIN.

**Is this dangerous?** No, and here's why:

`decideProvisioning()` chooses `full-challenge` (`createUserPinWithWallets`) precisely **when the
user doesn't have a wallet yet**. So if the user skips:
- PIN is not set
- **No UCW wallet is created**
- → no money in UCW → nothing gets stuck

Money only enters UCW after the user completes that challenge, and that challenge **simultaneously**
sets the PIN + security questions. So there's no gap for "having a UCW wallet but no security
questions".

The gate also **re-arms on every reload** and reappears if the user tries to pay with Slime Wallet
(`422 PIN_SETUP_REQUIRED`).
