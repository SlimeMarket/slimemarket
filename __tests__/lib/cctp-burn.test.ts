import { describe, it, expect, vi } from "vitest";
import type { Log } from "viem";

// Cold import of the viem-backed module graph; see cctp-chains.test.ts.
vi.setConfig({ testTimeout: 60_000 });

import { burnedUsdcFromReceipt, formatUsdcAmount, MIN_FINALITY_STANDARD } from "@/lib/cctp/burn";
import { CCTP_TOKEN_MESSENGER_V2 } from "@/lib/cctp/chains";

/**
 * `burnedUsdcFromReceipt` reads the standard ERC-20 `Transfer` event rather than
 * CCTP's own `DepositForBurn`, so it keeps working if CCTP changes its event
 * shape again. That only holds if the topic filtering is exact — a loose match
 * would count unrelated transfers and report a bridged amount that never
 * happened.
 */

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const OTHER_TOKEN = "0x5425890298aed601595a70ab815c96711a31bc65" as const;
const USER = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
// `toUpperCase()` widens to `string`, which the viem `Address` parameter
// rejects — so the mixed-case comparison uses explicit literals.
const USDC_UPPER = "0x036CBD53842C5426634E7929541EC2318F3DCF7E" as const;
const USER_UPPER = "0x1111111111111111111111111111111111111111" as const;

/** Indexed address → 32-byte topic. */
function addrTopic(addr: string): `0x${string}` {
  return `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}` as `0x${string}`;
}

function transferLog(opts: {
  contract?: string;
  from?: string;
  to?: string;
  value: bigint;
  topics?: `0x${string}`[];
}): Log {
  return {
    address: opts.contract ?? USDC,
    topics:
      opts.topics ??
      ([TRANSFER_TOPIC, addrTopic(opts.from ?? USER), addrTopic(opts.to ?? CCTP_TOKEN_MESSENGER_V2)] as `0x${string}`[]),
    data: `0x${opts.value.toString(16).padStart(64, "0")}` as `0x${string}`,
    blockNumber: 1n,
    blockHash: `0x${"0".repeat(64)}` as `0x${string}`,
    transactionHash: `0x${"0".repeat(64)}` as `0x${string}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

describe("burnedUsdcFromReceipt", () => {
  it("sums the USDC transfer from the user into the TokenMessenger", () => {
    const logs = [transferLog({ value: 5_000_000n })];
    expect(burnedUsdcFromReceipt(logs, USER, USDC)).toBe(5_000_000n);
  });

  it("sums multiple matching transfers", () => {
    const logs = [transferLog({ value: 1_000_000n }), transferLog({ value: 2_500_000n })];
    expect(burnedUsdcFromReceipt(logs, USER, USDC)).toBe(3_500_000n);
  });

  it("ignores a transfer to someone other than the TokenMessenger", () => {
    const logs = [transferLog({ to: OTHER, value: 9_000_000n })];
    expect(burnedUsdcFromReceipt(logs, USER, USDC)).toBe(0n);
  });

  it("ignores a transfer FROM someone other than the user", () => {
    const logs = [transferLog({ from: OTHER, value: 9_000_000n })];
    expect(burnedUsdcFromReceipt(logs, USER, USDC)).toBe(0n);
  });

  it("ignores a Transfer emitted by a different token contract", () => {
    const logs = [transferLog({ contract: OTHER_TOKEN, value: 9_000_000n })];
    expect(burnedUsdcFromReceipt(logs, USER, USDC)).toBe(0n);
  });

  it("ignores logs whose topic0 is not the Transfer signature", () => {
    const logs = [
      transferLog({ value: 9_000_000n, topics: [`0x${"ab".repeat(32)}` as `0x${string}`] }),
    ];
    expect(burnedUsdcFromReceipt(logs, USER, USDC)).toBe(0n);
  });

  it("ignores non-standard logs with the wrong number of topics", () => {
    const logs = [transferLog({ value: 9_000_000n, topics: [TRANSFER_TOPIC] as `0x${string}`[] })];
    expect(burnedUsdcFromReceipt(logs, USER, USDC)).toBe(0n);
  });

  it("returns 0n for an empty receipt", () => {
    expect(burnedUsdcFromReceipt([], USER, USDC)).toBe(0n);
  });

  it("matches addresses case-insensitively", () => {
    const logs = [transferLog({ value: 7_000_000n })];
    expect(burnedUsdcFromReceipt(logs, USER_UPPER, USDC_UPPER)).toBe(7_000_000n);
  });

  it("skips a malformed data field without aborting the whole receipt", () => {
    const bad = { ...transferLog({ value: 0n }), data: "0xnothex" } as unknown as Log;
    const good = transferLog({ value: 4_000_000n });
    expect(burnedUsdcFromReceipt([bad, good], USER, USDC)).toBe(4_000_000n);
  });
});

describe("formatUsdcAmount", () => {
  it("formats whole amounts without a trailing decimal point", () => {
    expect(formatUsdcAmount(5_000_000n)).toBe("5");
  });

  it("trims trailing zeros but keeps significant decimals", () => {
    expect(formatUsdcAmount(1_500_000n)).toBe("1.5");
    expect(formatUsdcAmount(1_230_000n)).toBe("1.23");
    expect(formatUsdcAmount(1n)).toBe("0.000001");
  });

  it("handles zero", () => {
    expect(formatUsdcAmount(0n)).toBe("0");
  });
});

describe("CCTP constants", () => {
  it("requests the STANDARD finality threshold, not FAST", () => {
    // Every supported source chain is standard-only; asking for FAST is the
    // PRE_FINALITY_UNAVAILABLE / HTTP 422 failure the App Kit bridge hit.
    expect(MIN_FINALITY_STANDARD).toBe(2000);
  });

  it("targets the testnet TokenMessenger tier by default", () => {
    expect(CCTP_TOKEN_MESSENGER_V2.toLowerCase()).toBe(
      "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa",
    );
  });
});
