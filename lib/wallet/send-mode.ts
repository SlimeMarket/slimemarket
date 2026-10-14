/**
 * PURE decision core for the wallet Send/Withdraw path.
 *
 * Goal: an email-compromised account must NOT be able to drain funds — in
 * real mode every send requires the user's wallet PIN on their own device.
 *
 *   'legacy'         → dev/mock session (dev-token, mock wallet, or
 *                      CIRCLE_PAYMENTS_MOCK mode): existing platform-DCW
 *                      reimburse path, unchanged (Playwright automation safe).
 *   'ucw-challenge'  → real session + PIN ENABLED: UCW TRANSFER challenge —
 *                      funds move from the USER's own wallet, signed with
 *                      their PIN via Circle's hosted UI.
 *   'blocked'        → real session but PIN UNSET (422 PIN_SETUP_REQUIRED —
 *                      FE opens the setup gate) or LOCKED (423).
 *
 * Unit-tested in __tests__/lib/send-mode.test.ts.
 */

export type SendPathDecision =
  | { mode: "legacy" }
  | { mode: "ucw-challenge" }
  | { mode: "blocked"; httpStatus: number; code: "PIN_SETUP_REQUIRED" | "PIN_LOCKED" };

export function decideSendPath(args: {
  shouldMock: boolean;
  pinStatus: string;
}): SendPathDecision {
  if (args.shouldMock) return { mode: "legacy" };
  if (args.pinStatus === "UNSET") {
    return { mode: "blocked", httpStatus: 422, code: "PIN_SETUP_REQUIRED" };
  }
  if (args.pinStatus === "LOCKED") {
    return { mode: "blocked", httpStatus: 423, code: "PIN_LOCKED" };
  }
  // ENABLED (or any unknown-but-not-UNSET/LOCKED status) → real UCW path.
  return { mode: "ucw-challenge" };
}
