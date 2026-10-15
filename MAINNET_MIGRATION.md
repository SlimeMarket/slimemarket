# SlimeMarket — Arc Mainnet Migration Checklist

> Target: migrate dari Arc Testnet → Arc Mainnet.  
> Testnet tetap bisa jalan (beda `.env`), tapi production server dipoint ke mainnet.

---

## Phase 0 — Persiapan (JANGAN skip)

### 0.1 Backup data testnet (opsional)
```bash
# Dump database Supabase (cloud) sebelum apapun
pg_dump $DATABASE_URL > backup-testnet-$(date +%Y%m%d).sql
```

### 0.2 Verify `.env.mainnet` sudah lengkap
File `.env.mainnet` udah gw bikin — isi semua placeholder `<...>`.

---

## Phase 1 — Circle Console (developer.circle.com)

### 1.1 API Key Production
- Go to **Developer Services → API Keys**
- Create NEW key (bukan yang `TEST_API_KEY`)
- Copy ke `CIRCLE_API_KEY`

### 1.2 Entity Secret
- **SAMA** kayak testnet — satu entity secret per akun Circle
- `CIRCLE_ENTITY_SECRET` nggak perlu ganti

### 1.3 App ID
- **SAMA** — satu app per project (`CIRCLE_APP_ID`)
- `NEXT_PUBLIC_CIRCLE_APP_ID` = sama

### 1.4 Blockchain String
- Ganti dari `ARC-TESTNET` → `ARC`
- `CIRCLE_BLOCKCHAIN=ARC`

### 1.5 USDC Token ID (Mainnet)
- Console → Wallets → Configurator
- Pilih network **ARC** (bukan ARC-TESTNET)
- Copy token ID untuk **USDC**
- Beda dari testnet — jangan reuse testnet token ID

### 1.6 Wallet Set (Mainnet)
- Buat wallet set baru: **Developer Controlled**
- Copy `CIRCLE_WALLET_SET_ID`

### 1.7 Platform DCW (Mainnet)
- Di wallet set baru, create wallet: **SCA** (`circle_6900_singleowner_v4`)
- Ini yang bayar gas untuk SETIAP release/refund/slash
- **MUST funded dengan USDC mainnet > 5 USDC**
- Copy:
  - `PLATFORM_CIRCLE_WALLET_ID` (UUID)
  - `NEXT_PUBLIC_AGENT_WALLET_ID` (sama UUID)
  - `NEXT_PUBLIC_AGENT_WALLET_ADDRESS` (0x... address)
  - `TREASURY_WALLET_ID` (sama 0x... address)

### 1.8 App Kit (Mainnet)
- Console → Arc App Kit → Keys
- Environment: **production** (bukan sandbox)
- Copy `APP_KIT_API_KEY`
- `APP_KIT_ENV=production`

### 1.9 UCW (User Controlled Wallets)
- Console → Wallets → User Controlled
- Verify app config sudah mainnet (`CIRCLE_BLOCKCHAIN=ARC`)
- Email OTP template harus pakai `{{ email.otp }}`

---

## Phase 2 — Arc Network Config

### 2.1 RPC & Chain ID
```env
ARC_RPC_URL=https://rpc.mainnet.arc.io
ARC_CHAIN_ID=5042
ARC_EXPLORER_URL=https://arcscan.app/tx/
```

### 2.2 Gateway API
```env
GATEWAY_API_URL=https://gateway-api.circle.com/v1
```

### 2.3 USDC Contract
- **SAMA** address: `0x3600000000000000000000000000000000000000`
- Native USDC system token — address identik di testnet & mainnet

---

## Phase 3 — Deploy Escrow Contract ke Mainnet

### 3.1 Buat Deployer Wallet
```bash
# Generate deployer baru (JANGAN reuse testnet deployer)
node scripts/generate-deployer.mjs
```

### 3.2 Fund Deployer
- Top up deployer address dengan USDC mainnet (min 2 USDC untuk gas deploy)
- `ARC_DEPLOYER_PRIVATE_KEY` dan `ARC_DEPLOYER_ADDRESS` diisi di `.env.mainnet`

### 3.3 Deploy
```bash
# Pastikan .env.mainnet udah lengkap
cp .env.mainnet .env.production

# Deploy
node --env-file=.env.production --import tsx contracts/deploy.ts
```

### 3.4 Catat Output
- Copy `ESCROW_CONTRACT_ADDRESS` (0x...)
- Copy `ESCROW_START_BLOCK` (block number deploy)
- Paste ke `.env.production`

---

## Phase 4 — Preflight Check

```bash
node --env-file=.env.production --import tsx scripts/preflight-mainnet.ts
```

Must pass SEMUA check:
- ✅ RPC mainnet reachable
- ✅ Chain ID = 5042
- ✅ Deployer balance ≥ 2 USDC
- ✅ Platform DCW balance ≥ 5 USDC  ← **PENTING BANGET**
- ✅ Escrow contract deployed & readable
- ✅ Circle API key valid
- ✅ Supabase connected

---

## Phase 5 — Database (Supabase)

### 5.1 Pilih strategi

**Opsi A: Clean slate (recommended)**
- Hapus semua data testnet
- Run migration purge

**Opsi B: Keep test data (risky)**
- Data testnet tetap ada
- Risk: user test bisa login ke mainnet, order test muncul di dashboard

### 5.2 Run purge (Opsi A)
```bash
# ⚠️ DESTRUCTIVE — data testnet hilang permanen
psql $DATABASE_URL -f supabase/migrations/0099_purge_testnet_data.sql
```

### 5.3 Verifikasi bersih
```sql
SELECT COUNT(*) FROM users;      -- harus 0
SELECT COUNT(*) FROM orders;     -- harus 0
SELECT COUNT(*) FROM products;   -- harus 0
SELECT COUNT(*) FROM wl_deals;   -- harus 0
```

---

## Phase 6 — Deploy ke VPS

### 6.1 Update `.env.production` di server
```bash
ssh root@95.111.199.180
cd /srv/slimemarket
# Edit .env.production — isi semua mainnet value
```

### 6.2 Build & Restart
```bash
cd /srv/slimemarket
git pull origin public-final
npm run build
pm2 restart ecosystem.config.cjs --update-env
```

### 6.3 Verifikasi
```bash
curl -s https://slimemarket.app/api/health | jq .
```

Expected:
- `onChainFunds: true`
- `escrowAddress` = mainnet contract address
- `usdcAddress` = 0x3600...

---

## Phase 7 — Post-Launch Monitor

### 7.1 First real order
- Buat test order kecil ($1 USDC) via real wallet
- Verify:
  - Checkout → approve → confirm berjalan
  - Seller bisa mark delivered
  - Buyer bisa confirm receipt
  - Funds arrive di seller wallet

### 7.2 Indexer
- Monitor `/api/admin/indexer/run` (cron setiap 5 menit)
- Verify `on_chain_status` update dari `create_pending` → `CREATED` → `RELEASED`

### 7.3 DCW balance
- Monitor saldo platform DCW — kalau < 2 USDC, top up segera
- Tanpa gas DCW = nggak ada deal yang bisa settle

---

## API Key Summary (yang HARUS ganti)

| Key | Testnet Value | Mainnet Value | Action |
|-----|--------------|---------------|--------|
| `CIRCLE_API_KEY` | `TEST_API_KEY:...` | `LIVE_API_KEY:...` | Create NEW |
| `CIRCLE_BLOCKCHAIN` | `ARC-TESTNET` | `ARC` | Change |
| `CIRCLE_USDC_TOKEN_ID` | `15dc...` | `<mainnet-id>` | Copy from Console |
| `CIRCLE_WALLET_SET_ID` | `985c...` | `<mainnet-set>` | Create NEW |
| `PLATFORM_CIRCLE_WALLET_ID` | `1c53...` | `<mainnet-dcw>` | Create NEW |
| `APP_KIT_API_KEY` | `TEST_API_KEY:...` | `<live-key>` | Create NEW |
| `APP_KIT_ENV` | `sandbox` | `production` | Change |
| `ARC_RPC_URL` | `rpc.testnet.arc.io` | `rpc.mainnet.arc.io` | Change |
| `ARC_CHAIN_ID` | `5042002` | `5042` | Change |
| `ARC_EXPLORER_URL` | `testnet.arcscan.app` | `arcscan.app` | Change |
| `GATEWAY_API_URL` | `gateway-api-testnet...` | `gateway-api.circle.com` | Change |
| `ESCROW_CONTRACT_ADDRESS` | `0x86fe...` | `<deploy-baru>` | Deploy NEW |
| `ESCROW_START_BLOCK` | `66961717` | `<deploy-block>` | Deploy NEW |

**Yang SAMA (nggak perlu ganti):**
- `CIRCLE_ENTITY_SECRET`
- `CIRCLE_APP_ID`
- `NEXT_PUBLIC_CIRCLE_APP_ID`
- `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` (0x3600...)
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `VALET_KEK_HEX`, `CSRF_SECRET`, `CRON_SECRET`
- `BREVO_API_KEY` (sama, Brevo nggak beda network)

---

## 🚨 Risiko & Mitigasi

| Risiko | Mitigasi |
|--------|----------|
| DCW kehabisan gas | Monitor balance, set alert < 5 USDC |
| Deployer key leak | Jangan commit, store di `.secrets/` (gitignored) |
| Contract deploy gagal (gas) | Preflight check deployer balance |
| Wrong chain ID | Preflight check RPC chain id |
| Testnet data bercampur | Run purge migration sebelum launch |
| Circle API key testnet | Preflight validate API key |
