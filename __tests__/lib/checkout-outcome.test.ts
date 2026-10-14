import { describe, it, expect } from "vitest";
import { resolveCheckoutOutcome } from "@/lib/order/checkout";

/**
 * the "did the buyer actually pay?" gate.
 *
 * Regression guard for the worst possible payment bug: the relay to Circle used
 * to be wrapped in a non-fatal catch, so a failed relay still produced a 200 and
 * the UI rendered "Payment successful!" while no USDC had moved. These tests pin
 * the three outcomes so that can never silently come back.
 */
describe("resolveCheckoutOutcome — honesty gate for checkout confirm", () => {
  it("relay never started → failed (no funds moved, request must fail)", () => {
    expect(resolveCheckoutOutcome(false, null)).toBe("failed");
  });

  it("relay never started even if an id leaked through → still failed", () => {
    // Defensive: an id without a successful relay must not be treated as proof.
    expect(resolveCheckoutOutcome(false, "42")).toBe("failed");
  });

  it("relay accepted but no contract order id yet → pending (never success)", () => {
    expect(resolveCheckoutOutcome(true, null)).toBe("pending");
  });

  it("relay accepted and contract order id resolved → confirmed", () => {
    expect(resolveCheckoutOutcome(true, "42")).toBe("confirmed");
  });

  it("only the confirmed outcome may be presented as success", () => {
    const outcomes = [
      resolveCheckoutOutcome(false, null),
      resolveCheckoutOutcome(true, null),
      resolveCheckoutOutcome(true, "42"),
    ];
    expect(outcomes.filter((o) => o === "confirmed")).toHaveLength(1);
  });
});
