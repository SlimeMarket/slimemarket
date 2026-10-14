/**
 * ERC-3009 / CommercePaymentsProtocol stack removal.
 *
 * MarketEscrow non-custodial escrow is the single payment path. The
 * orphaned ERC-3009 "Commerce Payments" stack (contracts, API routes,
 * lib/payments helpers, tests) must be gone. Its corrupted contract
 * (three `receive()` declarations) previously broke `hardhat compile`
 * for the entire repo.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

describe("ERC-3009 stack removal", () => {
  it("app/api/erc3009/authorize/route.ts is gone", () => {
    expect(exists("app/api/erc3009/authorize/route.ts")).toBe(false);
  });

  it("app/api/erc3009 tree is gone", () => {
    expect(exists("app/api/erc3009")).toBe(false);
  });

  it("app/api/webhooks/erc3009-payment is gone", () => {
    expect(exists("app/api/webhooks/erc3009-payment")).toBe(false);
  });

  it("app/api/webhooks/payment-intents is gone", () => {
    expect(exists("app/api/webhooks/payment-intents")).toBe(false);
  });

  it("lib/payments/erc3009-auth.ts is gone", () => {
    expect(exists("lib/payments/erc3009-auth.ts")).toBe(false);
  });

  it("lib/payments tree is gone", () => {
    expect(exists("lib/payments")).toBe(false);
  });

  it("contracts/CommercePaymentsProtocol.sol is gone", () => {
    expect(exists("contracts/CommercePaymentsProtocol.sol")).toBe(false);
  });

  it("contracts dir contains MarketEscrow.sol but not CommercePaymentsProtocol.sol", () => {
    const entries = fs.readdirSync(path.join(root, "contracts"));
    expect(entries).toContain("MarketEscrow.sol");
    expect(entries).not.toContain("CommercePaymentsProtocol.sol");
    expect(entries).not.toContain("TokenCollector.sol");
    expect(entries).not.toContain("MockIntentStore.sol");
    expect(entries).not.toContain("interfaces");
  });

  it("deleted contract tests are gone", () => {
    expect(exists("test/CommercePaymentsProtocol.test.js")).toBe(false);
    expect(exists("test/TokenCollector.test.js")).toBe(false);
    expect(exists("test/integration")).toBe(false);
    expect(exists("__tests__/erc3009-verification.test.ts")).toBe(false);
  });

  it("kept contracts and tests are intact", () => {
    expect(exists("contracts/MarketEscrow.sol")).toBe(true);
    expect(exists("contracts/MultisigTreasury.sol")).toBe(true);
    // TreasuryMultiSig.sol was deleted on 2026-08-09: treasury unified on
    // MultisigTreasury.sol (see CONTRACTS_STATUS.md).
    expect(exists("contracts/TreasuryMultiSig.sol")).toBe(false);
    expect(exists("contracts/OperatorsGovernance.sol")).toBe(true);
    expect(exists("test/OperatorsGovernance.test.js")).toBe(true);
    expect(exists("app/api/webhooks/circle")).toBe(true);
  });
});
