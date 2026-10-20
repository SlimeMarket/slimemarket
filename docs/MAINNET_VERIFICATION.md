# Mainnet verification — on-chain proof

Bukti bahwa alur pembayaran SlimeMarket benar-benar jalan di **Arc mainnet** (bukan testnet,
bukan simulasi). Setiap baris di bawah bisa diverifikasi ulang dari chain, tanpa perlu login.

## Environment

| Item | Nilai |
|---|---|
| Network | Arc mainnet |
| Chain ID | `5042` (`0x13b2`) |
| RPC | `https://rpc.mainnet.arc.io` |
| Escrow contract | `0xfe76c63289dd8b5693277df261e4938bd8779d28` |
| USDC | `0x3600000000000000000000000000000000000000` (6 decimals) |
| Explorer | https://explorer.arc.io |

## Verified transactions

### 0. Empat order marketplace yang settled end-to-end (re-verified 2026-10-20)

Bukan cuma "checkout berhasil" — tiap order di bawah punya **dua** tx: satu saat buyer mendanai
escrow (`OrderCreated`), satu saat dana dilepas ke seller (`OrderReleased`). Semua `status = 0x1`.

| Order (DB) | Fund tx (`OrderCreated`) | Release tx (`OrderReleased`) | Amount in → out | Block (fund → release) |
|---|---|---|---|---|
| `1564e213-…b7e9fe` | [`0x3cee387b…c0547e`](https://explorer.arc.io/tx/0x3cee387bd946875067a0418b614b0437a833ad2d6832fa751b39008e1ec0547e) | [`0x6f4539e6…5830cad`](https://explorer.arc.io/tx/0x6f4539e614099affa33a327c84c6132f2019ed62ab6dd46c8c6b3f35f5830cad) | `0.051` → `0.049` | 26092238 → 26092568 |
| `3b7911ec-…0c08df` | [`0xb35c3fac…0ea5c`](https://explorer.arc.io/tx/0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c) | [`0x99546836…34b877`](https://explorer.arc.io/tx/0x995468369786f086f8052dff04c738057700c40df8a9543495fe42cd1a34b877) | `0.102` → `0.098` | 26372139 → 26372357 |
| `555d2044-…1e8dc7` | [`0x07a4ed6a…5c6b4d`](https://explorer.arc.io/tx/0x07a4ed6a1094bbf162b8f380a28405c79b38aa531c0c77a4e3e74144425c6b4d) | [`0x9ee4f88c…b7fb0eb4`](https://explorer.arc.io/tx/0x9ee4f88ced1c4c13bcfd73a48147cd63540716dc6a7e859f3291e836b7fb0eb4) | `0.0714` → `0.0686` | 26541444 → 26542124 |
| `96dbc304-…21364b` | [`0x2c1b7c39…9774607`](https://explorer.arc.io/tx/0x2c1b7c396338592b1c73ccc20f0eadee42be9e3339bf89b44d29ad6189774607) | [`0x9387cbfe…4b8b30`](https://explorer.arc.io/tx/0x9387cbfec1d60e74b9f13e8c7f1c66015d18ec829f45df6cb1f9aeaa3f4b8b30) | `0.1428` → `0.1372` | 26588842 → 26589443 |

Selisih in/out adalah fee platform + fee buyer (lihat `lib/fee.ts`), bukan dana hilang:
`0.051 − 0.049 = 0.002`, `0.102 − 0.098 = 0.004`, `0.0714 − 0.0686 = 0.0028`,
`0.1428 − 0.1372 = 0.0056`. Total USDC yang bergerak lewat escrow: **0.72 USDC**.

### 1. Checkout dengan external wallet (EIP-2612 permit, gasless)

| Field | Nilai |
|---|---|
| Tx hash | `0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c` |
| Explorer | https://explorer.arc.io/tx/0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c |
| Block | `26372139` (`0x192682b`) |
| Status | `success` (`0x1`) |
| To | `0xfe76c63289dd8b5693277df261e4938bd8779d28` (MarketEscrow) |
| From | `0x069fb57e95c1b46af2a4d6d3e7243e9e4195bb8d` (deployer EOA = relay operator) |
| Method | `createOrderFor(address,address,uint256,uint256,uint256,uint8,bytes32,bytes32)` — selector `0xe2aef08d` |
| Order (DB) | `3b7911ec-7c3a-4660-9745-2450dd0c08df` |
| Product | Code Buddy 30.000 Credits (seller `rimuru`) |
| Amount | item `0.10 USDC` + fee `0.002 USDC` = **`0.102 USDC`** (102000 micro) |

Decoded calldata (args):

```
buyer        0xD36583346C4Fe00730419260aAc490CFe286feE2   ← wallet external (Rabby)
seller       0x655d9aE2adec748Cd7269d8DEc6d85AFBc86994d
itemAmount   100000                                        (0.10 USDC, micro)
inspection   604800                                        (7 hari, detik)
deadline     0x6ad2fa03
permit       v / r / s                                     ← signature EIP-2612 dari buyer
```

Log yang dihasilkan:

- `Approval` di USDC `0x3600…0000`: `owner = 0xD365…feE2` → `spender = escrow`, `value = 0x18e70`
  (102000 micro = 0.102 USDC).
- `Transfer` dari native USDC emitter (`0xffff…fffe`) ke escrow, sebesar amount yang sama.

**Yang dibuktikan:**

1. Buyer membayar dari **wallet eksternalnya sendiri** (`0xD365…feE2`), bukan dari saldo platform.
2. Jalur **permit (gasless)** yang dipakai — buyer tidak menandatangani transaksi on-chain,
   hanya signature EIP-2612; relay dilakukan operator (`0x069f…5bb8`).
3. Kontrak escrow menerima allowance yang tepat (0.102 USDC) dan membuat order on-chain
   (`createOrderFor`), jadi `onChainOrderId` di DB punya pasangan nyata di chain.
4. Chain yang dipakai **mainnet 5042** — bukan `5042002` (testnet).

### 2. Send dari dashboard (Circle User-Controlled Wallet)

| Field | Nilai |
|---|---|
| Tx hash | `0x83d285c8522f5afe17023047216f43ebe542212a96303f5670c1601d2b13a90e` |
| Explorer | https://explorer.arc.io/tx/0x83d285c8522f5afe17023047216f43ebe542212a96303f5670c1601d2b13a90e |
| Block | `26396070` (`0x192c5a6`) |
| Status | `success` (`0x1`) |
| From | `0x655d9ae2adec748cd7269d8dec6d85afbc86994d` (UCW wallet milik user) |
| To | `0x3600000000000000000000000000000000000000` (USDC) |
| Method | `transfer(address,uint256)` — selector `0xa9059cbb` |
| Amount | `0x23280` = **144000 micro = 0.144 USDC** |
| Destination | `0xD36583346C4Fe00730419260aAc490CFe286feE2` |
| Gas used | `0xbf36` (48.950) |

Log yang dihasilkan:

- `Transfer` di USDC `0x3600…0000` (6 dp): `from 0x655d…994d` → `to 0xD365…feE2`, `value = 0x23280`.
- `Transfer` di native USDC emitter (`0xffff…fffe`, 18 dp) untuk jumlah yang sama
  (`0x1ff973cafa80000` = 0.144 USDC) — di Arc native dan ERC-20 adalah saldo yang sama.

**Yang dibuktikan:**

1. Wallet **user-controlled** (login email OTP, PIN di device user) benar-benar bisa mengirim
   USDC keluar — bukan wallet platform, bukan custodial.
2. Dana keluar dari alamat milik user (`0x655d…994d`), jadi tidak ada kunci platform yang bisa
   memindahkan saldo user.
3. Jalur token yang dipakai adalah USDC **ERC-20** (`0x3600…0000`, 6 dp) — sama dengan yang
   dipakai escrow, dan sama dengan hasil resolve `lib/circle/usdc-token.ts`.
4. Transfer disetujui lewat **PIN challenge** Circle (hosted UI), bukan raw private key.

## Cara verifikasi ulang

```bash
# checkout (external wallet → escrow)
curl -s https://rpc.mainnet.arc.io -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt",
       "params":["0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c"]}'

# send dari dashboard (UCW → external address)
curl -s https://rpc.mainnet.arc.io -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt",
       "params":["0x83d285c8522f5afe17023047216f43ebe542212a96303f5670c1601d2b13a90e"]}'
```

Cek untuk keduanya: `result.status == "0x1"`. Di tx checkout, `result.to` = escrow dan ada log
`Approval` dengan `spender = 0xfe76…9d28`. Di tx send, `result.to` = USDC `0x3600…0000` dan ada log
`Transfer` dari `0x655d…994d` ke `0xD365…feE2` sebesar `0x23280` (0.144 USDC).

## Konfigurasi yang dibutuhkan

`.env.production` (gitignored — jangan commit):

```
ARC_CHAIN_ID=5042
ARC_RPC_URL=https://rpc.mainnet.arc.io
CIRCLE_BLOCKCHAIN=ARC
CIRCLE_USDC_TOKEN_ID=5677d668-490d-51d3-82c7-b2b8313df2f4   # USDC ERC-20 (0x3600…, 6 dp)
```

> Entity Circle untuk Arc punya **dua** token USDC: native (18 dp, `isNative: true`) dan
> ERC-20 di `0x3600…0000` (6 dp). Yang dipakai app adalah yang ERC-20, karena cocok dengan
> `ARC_USDC_CONTRACT` dan aritmetika micro-USDC (6 desimal).
> **Jangan biarkan `CIRCLE_USDC_TOKEN_ID` berisi UUID nol** (`00000000-0000-0000-0000-000000000000`):
> Circle menolaknya dengan `400 API parameter invalid`, dan di UI muncul sebagai
> `Send failed: API parameter invalid` di halaman Wallet. Runtime sekarang me-resolve token id
> dari daftar saldo wallet (`lib/circle/usdc-token.ts`) dan mencoba varian lain kalau ditolak.

## Review system (off-chain)

Review pembeli tersimpan di Postgres (Supabase) dan tampil di halaman produk:

- Produk: Code Buddy 30.000 Credits → rating agregat **4.0** dari **2 review**.
- Review diverifikasi hanya bisa dikirim untuk order berstatus `DONE` milik pembeli
  (`POST /api/orders/[id]/review`).

Rating ini off-chain by design: menulis rating ke kontrak akan menambah biaya gas untuk
data yang tidak perlu trustless.
