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
| Explorer | https://arc.etherscan.io |

## Verified transactions

### 1. Checkout dengan external wallet (EIP-2612 permit, gasless)

| Field | Nilai |
|---|---|
| Tx hash | `0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c` |
| Explorer | https://arc.etherscan.io/tx/0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c |
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

## Cara verifikasi ulang

```bash
curl -s https://rpc.mainnet.arc.io -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt",
       "params":["0xb35c3fac051f5611ee3c06b117f79a9e7dd8c11563c22b8695f4201740e0ea5c"]}'
```

Cek: `result.status == "0x1"`, `result.to` = escrow, dan log `Approval` dengan
`spender = 0xfe76…9d28`.

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
