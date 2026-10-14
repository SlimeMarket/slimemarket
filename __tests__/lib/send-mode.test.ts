import { describe, it, expect } from "vitest";
import { decideSendPath } from "@/lib/wallet/send-mode";

/**
 * Send/Withdraw path decision. Email-compromised accounts must
 * not be able to drain funds: real sends require the wallet PIN on the
 * user's device (UCW transfer challenge). Mock/dev stays on the legacy
 * platform-DCW reimburse path (Playwright automation unaffected).
 */
describe("decideSendPath", () => {
  it("mock session → legacy path regardless of PIN status", () => {
    expect(decideSendPath({ shouldMock: true, pinStatus: "UNSET" })).toEqual({ mode: "legacy" });
    expect(decideSendPath({ shouldMock: true, pinStatus: "ENABLED" })).toEqual({ mode: "legacy" });
  });

  it("real + PIN ENABLED → UCW transfer challenge", () => {
    expect(decideSendPath({ shouldMock: false, pinStatus: "ENABLED" })).toEqual({
      mode: "ucw-challenge",
    });
  });

  it("real + PIN UNSET → blocked 422 PIN_SETUP_REQUIRED", () => {
    expect(decideSendPath({ shouldMock: false, pinStatus: "UNSET" })).toEqual({
      mode: "blocked",
      httpStatus: 422,
      code: "PIN_SETUP_REQUIRED",
    });
  });

  it("real + PIN LOCKED → blocked 423 PIN_LOCKED", () => {
    expect(decideSendPath({ shouldMock: false, pinStatus: "LOCKED" })).toEqual({
      mode: "blocked",
      httpStatus: 423,
      code: "PIN_LOCKED",
    });
  });

  it("real + unknown status → UCW challenge (Circle will surface the real error)", () => {
    expect(decideSendPath({ shouldMock: false, pinStatus: "WEIRD" })).toEqual({
      mode: "ucw-challenge",
    });
  });
});
