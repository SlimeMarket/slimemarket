# Deploy pre-flight — what was actually verified

> 2026-10-11. Everything below was **executed and observed on this machine**, not
> reasoned about. Each item says how it was checked, so it can be re-checked.
>
> Purpose: find the deploy-day failures *before* deploy day. Three real blockers
> were found this way — two of them would have stopped the image from building
> at all.

---

## 1. ❌→✅ `docker build` could not build the image (FIXED)

**Symptom:** `docker compose build web` died at the deps stage:

```
npm error code ERESOLVE
While resolving: @rainbow-me/rainbowkit@2.2.11
Found: wagmi@3.7.1
Could not resolve dependency: peer wagmi@"^2.9.0" from @rainbow-me/rainbowkit@2.2.11
```

**Why it never showed up locally:** `node_modules` was already installed, so no
command ever re-validated peers. A fresh `npm ci` does, and it refuses.

**Root cause:** `@rainbow-me/rainbowkit` peers on `wagmi@^2.9.0`; this project runs
`wagmi@3.7.1`. RainbowKit's newest release is **still** 2.2.11 and still declares
the v2 range — there is no version that supports wagmi v3, so upgrading cannot
resolve it.

**Why the combination is nevertheless fine:** both bundles build and run against
it today. Only npm's peer *validation* is unhappy.

**Fix:** added `.npmrc` with `legacy-peer-deps=true` and made the Dockerfile copy
it before `npm ci`:

```dockerfile
COPY package.json package-lock.json .npmrc ./
RUN npm ci
```

Without the `.npmrc` copy the flag never reaches the container — the file must be
in the build context *and* copied, since `.dockerignore` is applied to `COPY . .`
but not to the earlier explicit `COPY` lines.

---

## 2. ❌→✅ esbuild could not resolve optional wagmi connectors (FIXED)

**Symptom:** after fixing #1, the build failed one stage later, in
`build:wallet-bridge`:

```
✘ [ERROR] Could not resolve "porto"
    node_modules/@wagmi/connectors/dist/esm/porto.js:50:32
✘ [ERROR] Could not resolve "@base-org/account"
✘ [ERROR] Could not resolve "@coinbase/wallet-sdk"
✘ [ERROR] Could not resolve "@walletconnect/ethereum-provider"
✘ [ERROR] Could not resolve "@safe-global/safe-apps-sdk"
```

**Root cause:** `@wagmi/connectors` dynamically imports these for connectors this
app never uses (Porto, Coinbase, Safe, Base, WalletConnect). They are **not in
`package-lock.json`** and are **not installed locally either** — verified by
`find node_modules`. The local build happened to resolve them; the clean install
inside Docker did not. That difference is exactly the kind of thing that only
shows up in a fresh environment.

**Fix:** mark them `--external:`, the same treatment the script already gave
`@metamask/connect-evm`. Leaving them external keeps the dynamic import in the
bundle, so it fails gracefully at runtime if such a connector is ever requested —
and the app does not request them.

`package.json` → `build:wallet-bridge` and `build:app-kit-bridge` now carry:

```
--external:@metamask/connect-evm
--external:porto --external:porto/internal
--external:@base-org/account --external:@coinbase/wallet-sdk
--external:@walletconnect/ethereum-provider --external:@safe-global/safe-apps-sdk
```

Side benefit: the wallet-bridge bundle went from ~47 s to ~2 s to build and shrank
from 3.6 MB to 3.4 MB, because esbuild no longer walks those trees.

---

## 3. ⚠️ Migrations REQUIRE a real Supabase stack — not plain Postgres

**How it was checked:** created a scratch database, applied all 92 migration files
in filename order with `psql -v ON_ERROR_STOP=1`.

| Environment | Result |
|---|---|
| Plain Postgres (empty DB) | ❌ fails on `0001` — `publication "supabase_realtime" does not exist`, then `schema "auth" does not exist` |
| Postgres + a hand-made `auth` schema | ⚠️ down to 4 failures — `function auth.uid() does not exist`, `column "instance_id" of relation "users" does not exist` |
| Real Supabase (Cloud or the official `supabase/docker` compose) | ✅ expected — GoTrue creates the real `auth` schema, Realtime creates the publication |

**What this means for the VPS:**

- **Supabase Cloud** → fine, everything the migrations need already exists.
- **Self-hosted Supabase** → you MUST use the official `supabase/docker` compose
  (it runs GoTrue, Realtime, PostgREST, Storage). A bare `postgres:16` container
  **will not work** — the migrations will abort partway and leave a half-built
  schema.
- Order matters: let the Supabase stack finish its own bootstrap (so `auth` and
  `supabase_realtime` exist) **before** applying app migrations.

The migrations depend on these Supabase-provided objects:

| Object | Uses |
|---|---|
| `auth.uid()` | 7 |
| `auth.users` | 7 |
| `supabase_realtime` publication | 1 |
| `auth.users.instance_id` | 1 |

---

## 4. ⚠️ `schema_migrations` is not a reliable progress record

`supabase/migrations/` holds **92** files; `supabase_migrations.schema_migrations`
holds **78** rows. The project applies migrations with raw `psql`, which does not
write to that table, so the count is expected to drift and must not be used to
decide what has been applied.

**For a fresh database, apply all 92 in filename order** — they are written
idempotently (`if not exists`, `drop … if exists`) and that is what was tested.

---

## 5. ⚠️ Redis is mandatory in production

`lib/rate-limit.ts` **throws** when `NODE_ENV=production` and no Redis client is
configured:

```
Redis unavailable - production deployment requires Upstash/Redis for rate limiting.
```

Every rate-limited endpoint (withdraw, checkout, cross-chain, …) becomes a 500.
Upstash's free tier is enough for a test launch, or self-host Redis on the same
box. This is not optional and it fails loudly, so it will be noticed — but better
to have it configured before the first request.

---

## 6. 📋 Env vars: audited against the code

All 109 `process.env.*` reads in the repo were extracted and diffed against
`.env.example`.

Most of the 55 that are absent from the templates are dev/test-only (`E2E_*`,
`DEV_LOGIN_WALLETS`, `OTP_FROM_FILE`, `HARDHAT_NETWORK`, …) or deploy-time-only
(`DEPLOYER_PRIVATE_KEY`, `ARC_DEPLOYER_*`), and every remaining one has a code
fallback.

Two were checked specifically because they *look* mandatory and are **not**:

- **`CSRF_SECRET`** — read by `lib/security/csrf.ts`, which is imported **only by
  its own test**. The middleware uses `lib/security/csrf-origin.ts` instead. No
  action needed.
- **`ENCRYPTION_KEY`** — read by `lib/crypto/encryption.ts`, which **nothing
  imports**. No action needed. (See §7 — the same module's absence has a real
  consequence elsewhere.)

---

## 7. 🔴 Not a blocker, but known: order credentials are stored in plaintext

Raised here because it is a security-relevant fact about the deployed system, not
because it stops a deploy.

**What was verified:**

- `orders.credentials_vault_ref` is written by `send_order`
  (`supabase/migrations/0007_order_m3.sql:129`) as
  `credentials_vault_ref = p_credentials::text` — the raw JSON, **not encrypted**.
- It is read back with a bare `JSON.parse` (`lib/order/mappers.ts:62`), no decrypt.
- The `secret_vault` table exists but holds **0 rows**, and
  `lib/crypto/encryption.ts` — the only module that touches it — is imported by
  **nothing**. The design clearly intended encryption; it was never wired.

**Exposure is bounded — and this was probed, not assumed.** With the anon key
against PostgREST:

| Probe | Result |
|---|---|
| `GET /rest/v1/orders?select=credentials_vault_ref` | `200` with `[]` — zero rows |
| `POST /rest/v1/orders` | `401` — RLS violation |
| `PATCH /rest/v1/orders?id=eq.<real id>` | `200` with `[]`, and the stored value was **unchanged** |

RLS is enabled with no policies, which is deny-by-default. So credentials are
**not publicly readable**. The remaining exposure is a database dump/backup, the
service-role key, direct staff access, or any future RLS mistake — which for a
product whose listings include wallet surrenders and account credentials is worth
closing, but is not a launch blocker.

---

## 8. Still unverified (needs the VPS)

- `docker compose up` end-to-end, and the healthcheck going green.
- TLS via the reverse proxy, and that `NEXT_PUBLIC_APP_URL` matches the real host.
- Migrations against a real Supabase (Cloud or self-hosted) — §3 predicts success
  but it has not been run.
- The scheduler container actually firing the cron jobs against the deployed app.
- Arc mainnet: contract deploy, funding, and the runbook in `MAINNET_LAUNCH.md`.

---

## Quick re-check commands

```bash
# 1 + 2 — the image must build from scratch
docker compose --env-file .env.production build web

# 3 — migrations against a real Supabase, not a bare Postgres
ls supabase/migrations/*.sql | wc -l          # expect 92

# 6 — re-run the env audit after adding any env var
node -e "const fs=require('fs');/* see git history for the extractor */"

# 7 — confirm the credential column is still unreadable by anon
curl -s "$SUPABASE_URL/rest/v1/orders?select=credentials_vault_ref&limit=1" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
# expect: []
```
