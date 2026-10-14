# Frontend audit — what to change, replace, or delete

> 2026-10-06. Scope: `public/*.jsx` (the SPA) + the enums it renders.
> Verdict: **the frontend is in good shape.** Nothing here is a launch blocker;
> items 1–2 are the ones with real user-visible value.

---

## 1. ✅ DONE — `PaymentMethod` enum renamed to English (migration 0089)

`lib/types.ts` used to read:

```ts
export type PaymentMethod = "Saldo" | "Langsung";
```

That was **exactly the same class of problem as the WL/rekber status enums** renamed on
2026-10-06 — an Indonesian value that leaked into a public codebase. The UI was already correct
(`orders.jsx` renders `tr('od.balance', 'Balance')`), so nothing user-facing was broken; it was the
*enum* that read as Indonesian.

**Now**

| Before | After |
|---|---|
| `Saldo` | `Balance` |
| `Langsung` | `Direct` |
| `Onchain` | *(unchanged)* |

**What changed:** migration `0089` (drop CHECK → update the 3 rows → re-add CHECK → **fix the
column DEFAULT**, the step that was nearly missed in 0086) plus 17 code files.

⚠️ **`public/i18n.jsx` was deliberately NOT touched.** There `Saldo` appears as an Indonesian
*translation value* (`"od.balance": "Saldo"`, `"rk.balance": "Saldo"`) — that is the ID locale and
must stay. The rename was scoped to quoted enum values in every file **except** that one.

Verified: DB CHECK/DEFAULT/data, 0 leftover enum values in code, ID translations intact,
`tsc` clean, 30/30 SPA files parse, **631 tests pass**.

---

## 2. ✅ DONE (wrapping) — literal UI strings now go through `tr()`

User-visible text written straight into JSX never reached the i18n table, so it stayed English no
matter which language the user picked.

**What was done:** every standalone literal text node in the user-facing files is now wrapped in
`tr('key', 'English')`, so it can be translated:

| File | Strings wrapped |
|---|---|
| `balance.jsx` | 13 |
| `wl.jsx` | 7 |
| `seller.jsx` | 10 |
| `storefront.jsx` | 6 |
| `productdetail.jsx` | 6 |
| `userdash.jsx` | 6 |
| `escrow.jsx` | 11 |
| `orders.jsx` | 3 |
| `auth.jsx` | 5 |

**One thing is deliberately NOT changed:**

1. **The brand logo** — `auth.jsx` renders `Slime<span>Market</span>`. That is the product name, not
   copy; translating it would be a bug. These are the only two literal text nodes left in the
   user-facing files.

**Two sentence fragments — now FIXED (2026-10-07).** `escrow.jsx` used to interleave copy with
markup:

```jsx
Waiting for the <span>seller</span> to set the collateral amount & <span>Proceed</span>. …
```

which cannot be translated — a translator would have to guess the word order, and most languages
cannot reuse it. Both are now a single `tr()` call per sentence. The cost is the two inline
highlights (`seller`, `Proceed` rendered plain); the win is that the sentence is translatable at
all. Translatable beats two coloured words.

**Note on effect:** this change is *enabling* — English output is byte-identical (the `tr()`
fallback is the same text). Nothing user-visible changes until ID/ZH/RU entries are added for the
new keys. That is a translator's job; the keys are now in place for them.

`admin.jsx` (63 strings) was intentionally skipped — it is an internal staff console.

Verified: 30/30 SPA files parse, `/wallet` renders identically with a clean console, **631 tests pass**.

---

## 3. 🟡 Dead branch for a payment method that cannot be selected

- `app.jsx:1032` — `if (paymentMethod === 'fiat') { notify('Card / Bank payment is coming soon!') }`
- `storefront.jsx:414` — the `'Coming Soon'` fallback in the button label

Neither is reachable: the selector only ever sets `'external'` or `'ucw'`.

⚠️ **Do not delete without asking.** `app.jsx:1031` carries the comment `// Card / Bank — coming
soon`, which reads like a deliberate placeholder for a future fiat rail — the same pattern as the
PIN files below. If it is a placeholder, the fix is to *finish or hide* it, not to remove it.

---

## 4. ✅ NOT A FINDING — the "unused `NOTIF` export" was my own bad regex

The original scan extracted `Object.assign(window, { … })` names with `[A-Za-z, ]+`, which stops at
`_` — so `NOTIFS` was truncated to `NOTIF` and then "not found anywhere". Re-running with a regex
that includes `_` and digits returns **zero unused window exports**.

Recorded rather than deleted because the lesson is the reusable part: a scan that reports "unused"
is only as good as its tokenizer, and a truncated identifier looks exactly like a real finding.
Verify the extractor before trusting the extractor's output.

---

## ✅ Deliberately kept — DO NOT delete

`public/pin-management.jsx` and `public/pin-status-badge.jsx` are **not** loaded by `index.html`
(28 of 30 SPA files are). That is intentional, and documented at `index.html:153`:

> Circle auto-provisions the PIN for `authMode EMAIL` accounts (every account — email OTP is the
> only sign-in), so there is no user PIN UI. Both files stay in the repo for a future PIN-based auth
> mode; restore these two `<script>` tags to bring the UI back.

They are still syntax-checked by `scripts/check-fe-syntax.mjs`, so they will not rot silently.

---

## ✅ Already good (verified, not assumed)

- **0 broken script references** — every `<script src>` in `index.html` resolves.
- **0 `dangerouslySetInnerHTML` / `.innerHTML =` / `eval` / `new Function`** in the SPA.
- **Only 6 Indonesian words** anywhere in the UI, and every one is an internal enum value
  (`payment: 'Saldo'`) — none is text a user reads.
- The i18n table covers 4 languages with an integrity test (`i18n-integrity.test.ts`) guarding it.
