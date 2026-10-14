# Arc Mainnet Launch Runbook

Ordered, because several steps have hard dependencies. Every command is runnable
as written from the repo root.

> **Read §0 before touching anything.** The two ways this launch most likely
> fails are both balance problems, not code problems.

---

## 0. The two things that actually kill the launch

| Risk | Consequence | Checked by |
|---|---|---|
| **Platform DCW has no USDC** | It pays gas for every `releaseEscrow` / `refundEscrow` / `slash`. Empty → **no deal can ever be settled**. Buyer funds sit locked until the 30-day dispute backstop. | `preflight-mainnet.ts` |
| **Deployer has no USDC** | The contract deploy reverts and you burn a day. | `preflight-mainnet.ts` |

Both are checked. **Do not skip the preflight.**

A third, quieter one: a half-configured network (chain id set to mainnet, Circle
USDC token id still the testnet default). The app looks healthy while the DCW
resolves the wrong token. `assertArcNetworkConfig()` fails fast on this.

---

## 1. Fund the wallets

1. **Deployer EOA** — needs mainnet USDC for gas.
   - Address: `node -e "..."` or check `contracts/deploy.ts` output (it prints the deployer).
   - Key lives at `.secrets/deployer.key` (git-ignored).
2. **Platform DCW** — the relay wallet.
   - Address is printed by `deploy.ts` and stored in `TREASURY_WALLET_ID`.
   - Fund generously: it pays gas for **every** release/refund/slash, forever.
     For a few thousand deals, budget well beyond the minimum.

> Mainnet gas USDC is **not** from the faucet — request it through your Circle
> point of contact.

---

## 2. Write `.env.mainnet`

```bash
cp .env.example .env.mainnet
# then apply the "mainnet" section at the bottom of .env.example and fill in
# every <placeholder>
```

The one value people get wrong: **`CIRCLE_USDC_TOKEN_ID`**. The code default is
the *testnet* token id. Mainnet has its own — get it from the Circle console.

---

## 3. Preflight

```bash
node --env-file=.env.mainnet --import tsx scripts/preflight-mainnet.ts
```

Expected: every line `✓`, ending in `PREFLIGHT PASSED`.

It checks the network triple (chain id / RPC / Circle blockchain), that the RPC
really is the chain you think it is, both balances, that the escrow contract has
code, and that the service credentials are present.

**A `!` warning about `DEPLOYER_ADDRESS`/`PLATFORM_DCW_ADDRESS` means a balance
check was SKIPPED, not that it passed.** Fix the env and re-run.

---

## 4. Deploy the contract

```bash
node --env-file=.env.mainnet --import tsx contracts/deploy.ts
```

The banner must read `Arc Mainnet ⚠️ REAL MONEY (chainId 5042)`. If it says
Testnet, stop — `ARC_CHAIN_ID` is wrong.

The script writes `ESCROW_CONTRACT_ADDRESS` back into the env file and wires
owner / treasury / operator / middleman to the platform DCW.

---

## 5. Verify the deploy

```bash
node --env-file=.env.mainnet --import tsx scripts/verify-escrow-deploy.ts
```

Confirms the fee model, the settlement windows (delivery / confirm / dispute
backstop) and that the platform holds the roles it needs.

---

## 6. Re-point the app

1. Copy the mainnet values into the **deployment** environment (Vercel/host) —
   the app reads the same variable names.
2. Reset the indexer so it does not try to replay testnet history:
   ```sql
   delete from indexer_state;
   ```
3. Null out any `on_chain_order_id` / `on_chain_deal_id` rows — they reference
   the **testnet** contract's ids and are meaningless on mainnet.
4. Restart the app.
5. Confirm: `curl <host>/api/health` → `escrowAddress` is the mainnet contract,
   `chainId` is 5042.

---

## 7. Smoke test with real money (small)

Run one real deal end to end **before announcing**, with the smallest amount that
is still real:

1. Seller lists → buyer starts a deal → seller proceeds → deal reaches ESCROW.
2. Confirm the buyer's USDC actually left and the collateral is locked
   (check the explorer link in the UI).
3. Admin **releases** → seller is paid.
4. Repeat once with **refund**.

`scripts/e2e-escrow-testnet.ts` and `scripts/verify-dcw-relay.ts` are testnet
scripts (they sign with local keys and move faucet funds). On mainnet, do this by
hand through the UI — the point is to exercise the real Circle DCW path.

---

## 8. Rollback

The contract is immutable and owner-controlled. If something is wrong after
deploy:

- **Pause** — the contract has `requestPause` / `pause` with a delay. Verify the
  exact delay in `verify-escrow-deploy.ts` output before you need it.
- **Redeploy** — deploy a new contract and re-point `ESCROW_CONTRACT_ADDRESS`.
  Existing deals stay on the old contract and must still be settled there, so
  keep the old address and the old contract's middleman role intact until every
  deal is closed.

---

## Reference

| | |
|---|---|
| Chain ID (mainnet) | `5042` |
| Chain ID (testnet) | `5042002` |
| RPC (mainnet) | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| Gas token | USDC (native, no separate token) |
| Finality | 1 confirmation (deterministic) |
| `eth_getLogs` limit | 10,000 blocks per call — the indexer caps at 2,000 |
| Source | <https://docs.arc.io/arc/references/rpc-endpoints> |
