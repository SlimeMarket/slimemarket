import { describe, it, expect, vi, beforeEach } from "vitest";

// The real UCW SDK client (lib/circle/ucw-client.ts) is null unless
// CIRCLE_API_KEY is set. For wrapper tests we mock it with controllable
// methods so we can verify:
//   1. thin wrappers pass the right args to the SDK
//   2. every SDK throw is funneled through mapUcwError (UcwError out)
//   3. a null client throws UcwError("UCW not configured", _, 503)
const fakeSdk = {
  createUser: vi.fn(),
  createUserToken: vi.fn(),
  getUserStatus: vi.fn(),
  createUserPinWithWallets: vi.fn(),
  updateUserPin: vi.fn(),
  restoreUserPin: vi.fn(),
  listWallets: vi.fn(),
  createWallet: vi.fn(),
};

let sdkValue: unknown = fakeSdk;
vi.mock("@/lib/circle/ucw-client", () => ({
  get circleUcwSdk() {
    return sdkValue;
  },
}));

import {
  UcwError,
  mapUcwError,
  createOrGetCircleUser,
  issueUserToken,
  getCircleUserStatus,
  createPinSetupChallenge,
  createPinChangeChallenge,
  createPinRestoreChallenge,
  listUserWallets,
  createWalletOnlyChallenge,
  asCircleBlockchain,
} from "@/lib/circle/ucw-user";

/** Build an error shaped like what the @circle-fin SDK throws. */
function sdkError(code: number, message: string, status = 400) {
  const e: any = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

beforeEach(() => {
  sdkValue = fakeSdk;
  for (const fn of Object.values(fakeSdk)) fn.mockReset();
});

// ---------------------------------------------------------------------------
// mapUcwError — pure, table-driven
// ---------------------------------------------------------------------------
describe("mapUcwError", () => {
  // [circleCode, expected httpStatus, expected friendly message]
  const TABLE: Array<[number, number, string]> = [
    [155101, 409, "Circle user already exists"],
    [155102, 404, "Circle user not found"],
    [155103, 401, "Circle user token not found"],
    [155104, 401, "Circle user token expired"],
    [155105, 401, "Circle user token invalid"],
    [155106, 409, "Circle user already initialized"],
    [155107, 409, "PIN already set"],
    [155108, 409, "Security questions already set"],
    [155110, 400, "PIN not set yet"],
    [155112, 400, "Incorrect PIN"],
    [155115, 400, "Incorrect security answers"],
    [155119, 423, "PIN temporarily locked (cooldown)"],
    [155120, 423, "Security questions temporarily locked (cooldown)"],
    [155121, 400, "Challenge expired"],
    [155122, 400, "Challenge invalid"],
  ];

  it.each(TABLE)("maps code %i → http %i (%s)", (code, status, message) => {
    const err = mapUcwError(sdkError(code, "raw API message", 400));
    expect(err).toBeInstanceOf(UcwError);
    expect(err.code).toBe(code);
    expect(err.httpStatus).toBe(status);
    expect(err.message).toBe(message);
  });

  it("accepts string-typed codes (axios raw data)", () => {
    const err = mapUcwError(sdkError("155112" as unknown as number, "x"));
    expect(err.code).toBe(155112);
    expect(err.httpStatus).toBe(400);
  });

  it("falls back to SDK http status for unmapped codes", () => {
    const err = mapUcwError(sdkError(999999, "boom", 503));
    expect(err).toBeInstanceOf(UcwError);
    expect(err.httpStatus).toBe(503);
    expect(err.message).toBe("boom");
  });

  it("handles raw axios errors (response.data.code/message)", () => {
    const e: any = {
      isAxiosError: true,
      response: { data: { code: 155107, message: "pin exists" }, status: 409 },
      message: "Request failed with status code 409",
    };
    const err = mapUcwError(e);
    expect(err.code).toBe(155107);
    expect(err.httpStatus).toBe(409);
    expect(err.message).toBe("PIN already set");
  });

  it("maps unknown axios errors to their http status", () => {
    const e: any = {
      isAxiosError: true,
      response: { data: { message: "weird" }, status: 429 },
      message: "Request failed with status code 429",
    };
    const err = mapUcwError(e);
    expect(err.httpStatus).toBe(429);
    expect(err.code).toBeUndefined();
  });

  it("defaults to 502 for non-Error garbage and Error without info", () => {
    expect(mapUcwError(null).httpStatus).toBe(502);
    expect(mapUcwError("oops").httpStatus).toBe(502);
    const plain = mapUcwError(new Error("net down"));
    expect(plain.httpStatus).toBe(502);
    expect(plain.message).toBe("net down");
  });

  it("returns UcwError inputs unchanged", () => {
    const input = new UcwError("already mapped", 155102, 404);
    expect(mapUcwError(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// createOrGetCircleUser
// ---------------------------------------------------------------------------
describe("createOrGetCircleUser", () => {
  it("creates a user and reports created", async () => {
    fakeSdk.createUser.mockResolvedValue({ data: { id: "abc" } });
    const res = await createOrGetCircleUser("4CHA");
    expect(fakeSdk.createUser).toHaveBeenCalledWith({ userId: "4CHA" });
    expect(res).toEqual({ userId: "4CHA", status: "created" });
  });

  it("returns existing on 155101", async () => {
    fakeSdk.createUser.mockRejectedValue(sdkError(155101, "user exists"));
    await expect(createOrGetCircleUser("4CHA")).resolves.toEqual({
      userId: "4CHA",
      status: "existing",
    });
  });

  it("throws mapped UcwError on other failures", async () => {
    fakeSdk.createUser.mockRejectedValue(sdkError(155102, "nope"));
    const err = await createOrGetCircleUser("4CHA").catch((e) => e);
    expect(err).toBeInstanceOf(UcwError);
    expect(err.code).toBe(155102);
    expect(err.httpStatus).toBe(404);
  });

  it("throws 503 when SDK not configured", async () => {
    sdkValue = null;
    const err = await createOrGetCircleUser("4CHA").catch((e) => e);
    expect(err).toBeInstanceOf(UcwError);
    expect(err.message).toBe("UCW not configured");
    expect(err.httpStatus).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// issueUserToken
// ---------------------------------------------------------------------------
describe("issueUserToken", () => {
  it("returns userToken + encryptionKey", async () => {
    fakeSdk.createUserToken.mockResolvedValue({
      data: { userToken: "jwt.x", encryptionKey: "ek-1" },
    });
    const res = await issueUserToken("uid-1");
    expect(fakeSdk.createUserToken).toHaveBeenCalledWith({ userId: "uid-1" });
    expect(res).toEqual({ userToken: "jwt.x", encryptionKey: "ek-1" });
  });

  it("maps errors", async () => {
    fakeSdk.createUserToken.mockRejectedValue(sdkError(155104, "expired"));
    const err = await issueUserToken("uid-1").catch((e) => e);
    expect(err.code).toBe(155104);
    expect(err.httpStatus).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// getCircleUserStatus
// ---------------------------------------------------------------------------
describe("getCircleUserStatus", () => {
  it("maps EndUser response to pin/security status", async () => {
    fakeSdk.getUserStatus.mockResolvedValue({
      data: {
        pinStatus: "ENABLED",
        status: "ENABLED",
        pinDetails: { failedAttempts: 1, lockedExpiryDate: "2026-01-01T00:00:00Z" },
        securityQuestionDetails: { failedAttempts: 0 },
      },
    });
    const res = await getCircleUserStatus("tok");
    expect(fakeSdk.getUserStatus).toHaveBeenCalledWith({ userToken: "tok" });
    expect(res.pinStatus).toBe("ENABLED");
    expect(res.status).toBe("ENABLED");
    expect(res.pinDetails?.failedAttempts).toBe(1);
    expect(res.securityQuestionDetails?.failedAttempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PIN challenges (setup / change / restore) — arg shaping + error wrapping
// ---------------------------------------------------------------------------
describe("PIN challenge creators", () => {
  it("createPinSetupChallenge calls createUserPinWithWallets on ARC-TESTNET EOA", async () => {
    fakeSdk.createUserPinWithWallets.mockResolvedValue({
      data: { challengeId: "ch-1" },
    });
    const res = await createPinSetupChallenge("tok");
    expect(fakeSdk.createUserPinWithWallets).toHaveBeenCalledWith({
      userToken: "tok",
      blockchains: ["ARC-TESTNET"],
      accountType: "EOA",
    });
    expect(res).toEqual({ challengeId: "ch-1" });
  });

  it("createPinChangeChallenge calls updateUserPin", async () => {
    fakeSdk.updateUserPin.mockResolvedValue({ data: { challengeId: "ch-2" } });
    const res = await createPinChangeChallenge("tok");
    expect(fakeSdk.updateUserPin).toHaveBeenCalledWith({ userToken: "tok" });
    expect(res).toEqual({ challengeId: "ch-2" });
  });

  it("createPinRestoreChallenge calls restoreUserPin", async () => {
    fakeSdk.restoreUserPin.mockResolvedValue({ data: { challengeId: "ch-3" } });
    const res = await createPinRestoreChallenge("tok");
    expect(fakeSdk.restoreUserPin).toHaveBeenCalledWith({ userToken: "tok" });
    expect(res).toEqual({ challengeId: "ch-3" });
  });

  it("wraps errors (155107 on setup → 409)", async () => {
    fakeSdk.createUserPinWithWallets.mockRejectedValue(sdkError(155107, "pin set"));
    const err = await createPinSetupChallenge("tok").catch((e) => e);
    expect(err.code).toBe(155107);
    expect(err.httpStatus).toBe(409);
  });

  it("throws when no challengeId in response", async () => {
    fakeSdk.updateUserPin.mockResolvedValue({ data: {} });
    const err = await createPinChangeChallenge("tok").catch((e) => e);
    expect(err).toBeInstanceOf(UcwError);
    expect(err.httpStatus).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// listUserWallets — filters to ARC-TESTNET + maps fields
// ---------------------------------------------------------------------------
describe("listUserWallets", () => {
  it("filters ARC-TESTNET wallets and maps fields", async () => {
    fakeSdk.listWallets.mockResolvedValue({
      data: {
        wallets: [
          { id: "w1", address: "0xabc", blockchain: "ARC-TESTNET", state: "LIVE" },
          { id: "w2", address: "0xdef", blockchain: "ETH-SEPOLIA", state: "LIVE" },
        ],
      },
    });
    const res = await listUserWallets("tok");
    expect(fakeSdk.listWallets).toHaveBeenCalledWith({ userToken: "tok" });
    expect(res).toEqual([
      { id: "w1", address: "0xabc", blockchain: "ARC-TESTNET", state: "LIVE" },
    ]);
  });

  it("returns [] when no wallets", async () => {
    fakeSdk.listWallets.mockResolvedValue({ data: { wallets: [] } });
    await expect(listUserWallets("tok")).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createWalletOnlyChallenge
// ---------------------------------------------------------------------------
describe("createWalletOnlyChallenge", () => {
  it("calls createWallet on ARC-TESTNET EOA", async () => {
    fakeSdk.createWallet.mockResolvedValue({ data: { challengeId: "ch-w" } });
    const res = await createWalletOnlyChallenge("tok");
    expect(fakeSdk.createWallet).toHaveBeenCalledWith({
      userToken: "tok",
      blockchains: ["ARC-TESTNET"],
      accountType: "EOA",
    });
    expect(res).toEqual({ challengeId: "ch-w" });
  });

  it("passes an explicit chain list through (cross-chain provisioning)", async () => {
    fakeSdk.createWallet.mockResolvedValue({ data: { challengeId: "ch-x" } });
    await createWalletOnlyChallenge("tok", ["BASE-SEPOLIA", "AVAX-FUJI"]);
    expect(fakeSdk.createWallet).toHaveBeenCalledWith({
      userToken: "tok",
      blockchains: ["BASE-SEPOLIA", "AVAX-FUJI"],
      accountType: "EOA",
    });
  });

  it("rejects an empty chain list instead of asking Circle for nothing", async () => {
    await expect(createWalletOnlyChallenge("tok", [])).rejects.toThrow(/must not be empty/);
    expect(fakeSdk.createWallet).not.toHaveBeenCalled();
  });

  it("rejects an unknown chain name before hitting Circle", async () => {
    await expect(createWalletOnlyChallenge("tok", ["NOT-A-CHAIN"])).rejects.toThrow(
      /Unknown Circle blockchain identifier/,
    );
    expect(fakeSdk.createWallet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// asCircleBlockchain — narrows env/config strings to the SDK's closed union.
// A typo here would otherwise reach Circle as an opaque error, or provision a
// wallet on the wrong chain.
// ---------------------------------------------------------------------------
describe("asCircleBlockchain", () => {
  it("accepts the identifiers this app actually uses", () => {
    for (const id of [
      "ARC-TESTNET", "ARC", "BASE-SEPOLIA", "AVAX-FUJI", "ARB-SEPOLIA", "ETH-SEPOLIA",
      "BASE", "AVAX", "ARB", "ETH",
    ]) {
      expect(asCircleBlockchain(id)).toBe(id);
    }
  });

  it("normalises case and trims whitespace", () => {
    expect(asCircleBlockchain("  base-sepolia ")).toBe("BASE-SEPOLIA");
    expect(asCircleBlockchain("arc-testnet")).toBe("ARC-TESTNET");
  });

  it("throws on an unknown identifier", () => {
    expect(() => asCircleBlockchain("SOLANA")).toThrow(/Unknown Circle blockchain identifier/);
    expect(() => asCircleBlockchain("")).toThrow(/Unknown Circle blockchain identifier/);
    expect(() => asCircleBlockchain("BASE-SEPOLIA-2")).toThrow(/Unknown Circle blockchain identifier/);
  });
});
