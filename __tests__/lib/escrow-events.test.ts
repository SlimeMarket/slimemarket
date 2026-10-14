import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  encodeAbiParameters,
  encodeEventTopics,
  decodeEventLog,
  type Abi,
  type Hex,
} from "viem";
import {
  ESCROW_EVENTS_ABI,
  ESCROW_LIFECYCLE_ABI,
  ESCROW_CREATION_ABI,
  ESCROW_EVENT_SIGNATURES,
} from "@/lib/contracts/escrow-events";

/**
 * REGRESSION GUARD — escrow event ABI must match the compiled contract.
 *
 * THE BUG THIS PREVENTS (found 2026-09-26):
 *   Three files hand-wrote the escrow event ABI and all three drifted:
 *     - lib/contracts/resolver.ts   OrderCreated  → 4 args (contract: 5)
 *     - lib/contracts/indexer.ts    OrderReleased → 5 args (contract: 4)
 *     - scripts/setup-event-monitors.ts  DealRefunded → 3 args (contract: 2)
 *
 *   `parseEventLogs`/`decodeEventLog` match logs by topic0 = keccak256(signature).
 *   A wrong arity produces a DIFFERENT topic0, so viem silently skips the log —
 *   no exception, no warning. Effect: `resolveOrderIdFromTxHash()` always returned
 *   null, `on_chain_order_id` was never written, and the whole escrow release
 *   path was unreachable. The monitors for the wrong signature simply never fire.
 *
 * These tests fail loudly if the generated ABI ever drifts from the artifact
 * again. They are cheap and they protect the money path.
 */

interface AbiParam {
  name?: string;
  type: string;
  indexed?: boolean;
}
interface AbiEvent {
  name: string;
  type: string;
  anonymous?: boolean;
  inputs: AbiParam[];
}

const artifact = JSON.parse(
  readFileSync(resolve(process.cwd(), "contracts", "MarketEscrow.json"), "utf8"),
) as { abi: AbiEvent[] };

const artifactEvents = artifact.abi.filter((x) => x.type === "event");

/** "OrderCreated(uint256,address,address,uint256,uint256)" */
const sigOf = (e: { name: string; inputs: AbiParam[] }) =>
  `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;

/** "indexed,not,not" — arity alone is not enough, indexing changes topics[]. */
const indexedOf = (e: { inputs: AbiParam[] }) =>
  e.inputs.map((i) => (i.indexed ? "indexed" : "plain")).join(",");

const trackedNames = new Set([
  // creation — used to correlate a tx hash back to a contract id
  "OrderCreated",
  "DealCreated",
  // lifecycle — drive DB status
  "OrderReleased",
  "OrderRefunded",
  "OrderDelivered",
  "OrderConfirmed",
  "DealReleased",
  "DealRefunded",
  // added with the hardened escrow contract (settlement clocks + fraud slash)
  "DealRefundedWithSlash",
  "DealDisputed",
  "DealDelivered",
  "DealConfirmed",
  "CollateralAdded",
  // added with the collateral-first shell flow (A2)
  "DealFunded",
  // platform fees
  "FeesCollected",
]);

describe("escrow-events (generated ABI)", () => {
  it("covers exactly the same event set as the compiled artifact", () => {
    const fromArtifact = artifactEvents.map(sigOf).sort();
    const fromGenerated = (ESCROW_EVENTS_ABI as unknown as AbiEvent[]).map(sigOf).sort();
    expect(fromGenerated).toEqual(fromArtifact);
  });

  it("matches indexed-argument layout for every event", () => {
    const generated = ESCROW_EVENTS_ABI as unknown as AbiEvent[];
    for (const artifactEvent of artifactEvents) {
      const match = generated.find((g) => sigOf(g) === sigOf(artifactEvent));
      expect(match, `missing event ${sigOf(artifactEvent)}`).toBeDefined();
      expect(
        indexedOf(match!),
        `indexed layout mismatch for ${sigOf(artifactEvent)}`,
      ).toBe(indexedOf(artifactEvent));
    }
  });

  it("exposes every tracked signature verbatim from the artifact", () => {
    const expected = artifactEvents
      .filter((e) => trackedNames.has(e.name))
      .map(sigOf)
      .sort();
    expect(expected).toHaveLength(trackedNames.size);
    expect([...ESCROW_EVENT_SIGNATURES].sort()).toEqual(expected);
  });

  it("contains no spaces in any signature (Circle rejects them)", () => {
    for (const sig of ESCROW_EVENT_SIGNATURES) {
      expect(sig).not.toMatch(/\s/);
    }
  });

  describe("canaries — the exact signatures that were previously wrong", () => {
    const sigs = new Set<string>(ESCROW_EVENT_SIGNATURES as unknown as string[]);

    it("OrderCreated carries the fee argument (5 args)", () => {
      expect(sigs.has("OrderCreated(uint256,address,address,uint256,uint256)")).toBe(true);
      expect(sigs.has("OrderCreated(uint256,address,address,uint256)")).toBe(false);
    });

    it("OrderReleased has NO fee argument (4 args)", () => {
      expect(sigs.has("OrderReleased(uint256,address,address,uint256)")).toBe(true);
      expect(sigs.has("OrderReleased(uint256,address,address,uint256,uint256)")).toBe(false);
    });

    it("DealRefunded carries buyer, amount and collateralReturned (5 args)", () => {
      // Grew from (id, mm) when the hardened contract started reporting the
      // refunded amount and how much collateral went back — the DB needs both
      // to reconcile a settlement without re-reading the deal struct.
      expect(
        sigs.has("DealRefunded(uint256,address,address,uint256,uint256)"),
      ).toBe(true);
      expect(sigs.has("DealRefunded(uint256,address)")).toBe(false);
    });

    it("DealRefundedWithSlash exists and carries the forfeited collateral", () => {
      // Fraud settlement: buyer receives price + collateral. Without this event
      // in the tracked set the indexer would never settle a slashed deal.
      expect(
        sigs.has("DealRefundedWithSlash(uint256,address,address,uint256,uint256)"),
      ).toBe(true);
    });

    it("DealCreated carries price, fee and collateral (6 args)", () => {
      expect(
        sigs.has("DealCreated(uint256,address,address,uint256,uint256,uint256)"),
      ).toBe(true);
    });
  });

  it("lifecycle + creation subsets are both contained in the full ABI", () => {
    const full = new Set((ESCROW_EVENTS_ABI as unknown as AbiEvent[]).map(sigOf));
    for (const e of ESCROW_LIFECYCLE_ABI as unknown as AbiEvent[]) {
      expect(full.has(sigOf(e)), `lifecycle ${sigOf(e)} not in full ABI`).toBe(true);
    }
    for (const e of ESCROW_CREATION_ABI as unknown as AbiEvent[]) {
      expect(full.has(sigOf(e)), `creation ${sigOf(e)} not in full ABI`).toBe(true);
    }
  });

  it("lifecycle and creation subsets do not overlap", () => {
    const lifecycle = new Set((ESCROW_LIFECYCLE_ABI as unknown as AbiEvent[]).map(sigOf));
    const creation = (ESCROW_CREATION_ABI as unknown as AbiEvent[]).map(sigOf);
    for (const sig of creation) {
      expect(lifecycle.has(sig), `${sig} appears in both subsets`).toBe(false);
    }
  });
});

/**
 * Round-trip tests. These build a log the way Circle delivers it (raw topics +
 * data) and decode it exactly like `app/api/webhooks/escrow/route.ts` does.
 * They also pin down WHY the old hand-written ABI was fatal.
 */
describe("escrow-events — webhook decode round-trip", () => {
  const MM = "0x8fA56501139c0f23Af234A24a13840950037Eb83" as const;
  const SELLER = "0x1111111111111111111111111111111111111111" as const;
  const BUYER = "0x2222222222222222222222222222222222222222" as const;

  it("decodes a real OrderReleased log (4 args — the previously broken one)", () => {
    const topics = encodeEventTopics({
      abi: ESCROW_EVENTS_ABI,
      eventName: "OrderReleased",
      args: { id: 42n },
    });
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [MM, SELLER, 980_000n],
    );

    const decoded = decodeEventLog({
      abi: ESCROW_EVENTS_ABI,
      data,
      topics: topics as [Hex, ...Hex[]],
    });

    expect(decoded.eventName).toBe("OrderReleased");
    const args = decoded.args as unknown as { id: bigint; payout: bigint };
    expect(args.id).toBe(42n);
    expect(args.payout).toBe(980_000n);
  });

  it("decodes a real DealRefunded log (5 args: mm, buyer, amount, collateralReturned)", () => {
    const topics = encodeEventTopics({
      abi: ESCROW_EVENTS_ABI,
      eventName: "DealRefunded",
      args: { id: 7n },
    });
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [MM, BUYER, 500_000n, 200_000n],
    );

    const decoded = decodeEventLog({
      abi: ESCROW_EVENTS_ABI,
      data,
      topics: topics as [Hex, ...Hex[]],
    });

    expect(decoded.eventName).toBe("DealRefunded");
    const args = decoded.args as unknown as {
      id: bigint; mm: string; buyer: string; amount: bigint; collateralReturned: bigint;
    };
    expect(args.id).toBe(7n);
    expect(args.buyer.toLowerCase()).toBe(BUYER.toLowerCase());
    expect(args.amount).toBe(500_000n);
    expect(args.collateralReturned).toBe(200_000n);
  });

  it("decodes a real OrderCreated log (5 args — resolver.ts was missing fee)", () => {
    const topics = encodeEventTopics({
      abi: ESCROW_EVENTS_ABI,
      eventName: "OrderCreated",
      args: { id: 1n },
    });
    const data = encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [BUYER, SELLER, 100_000n, 2_000n],
    );

    const decoded = decodeEventLog({
      abi: ESCROW_EVENTS_ABI,
      data,
      topics: topics as [Hex, ...Hex[]],
    });

    expect(decoded.eventName).toBe("OrderCreated");
    expect((decoded.args as unknown as { id: bigint }).id).toBe(1n);
  });

  it("PROVES the old wrong OrderReleased ABI could not decode the same log", () => {
    // This is the exact declaration that used to live in lib/contracts/indexer.ts:
    // an extra `fee` argument that the contract never emits.
    const wrongAbi = [
      {
        name: "OrderReleased",
        type: "event",
        anonymous: false,
        inputs: [
          { name: "id", type: "uint256", indexed: true },
          { name: "mm", type: "address", indexed: false },
          { name: "seller", type: "address", indexed: false },
          { name: "payout", type: "uint256", indexed: false },
          { name: "fee", type: "uint256", indexed: false },
        ],
      },
    ] as const;

    const topics = encodeEventTopics({
      abi: ESCROW_EVENTS_ABI,
      eventName: "OrderReleased",
      args: { id: 42n },
    });
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [MM, SELLER, 980_000n],
    );

    // topic0 differs → viem cannot match the event. This throw IS the bug:
    // in production it was swallowed and the log was silently skipped.
    expect(() =>
      decodeEventLog({
        abi: wrongAbi as unknown as Abi,
        data,
        topics: topics as [Hex, ...Hex[]],
      }),
    ).toThrow();
  });
});
