/**
 * KYC removal from backend.
 *
 * Migration 0021 already dropped `users.kyc` and `seller_applications.kyc`;
 * these tests assert the runtime TypeScript no longer references KYC.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

describe("KYC removal", () => {
  it("lib/types does not export KycStatus", async () => {
    const mod = (await import("@/lib/types")) as Record<string, unknown>;
    expect(Object.keys(mod)).not.toContain("KycStatus");
    // Type aliases are erased at compile time, so also assert on source text:
    // the declaration must be gone from lib/types.ts.
    const src = fs.readFileSync(path.join(root, "lib/types.ts"), "utf8");
    expect(src).not.toMatch(/KycStatus/);
  });

  it("shapeCurrentUser omits kyc and preserves core fields", async () => {
    const mod = (await import("@/lib/auth-ucw")) as Record<string, unknown>;
    expect(typeof mod.shapeCurrentUser).toBe("function");
    const shape = mod.shapeCurrentUser as (row: Record<string, unknown>) => Record<string, unknown>;

    const shaped = shape({
      id: "x",
      uid: "USR-1",
      name: "n",
      handle: "@n",
      email: "e",
      role: "Buyer",
      tx_count: 3,
      kyc: "verified", // leftover column value in the row must NOT leak through
      avatar_url: null,
      avatar_gradient: null,
      banner_gradient: null,
      referral_code: "RC123",
      preferred_lang: "en",
      contacts: {},
      joined_at: "2026-01-01T00:00:00Z",
      circle_user_id: "cu_1",
      banned: false,
      banned_reason: null,
    });

    expect(Object.keys(shaped)).not.toContain("kyc");
    expect(shaped.id).toBe("x");
    expect(shaped.email).toBe("e");
    expect(shaped.name).toBe("n");
    expect(shaped.role).toBe("Buyer");
  });

  it("app/api/me/kyc route is deleted", () => {
    expect(fs.existsSync(path.join(root, "app/api/me/kyc/route.ts"))).toBe(false);
  });

  it("app/api/withdrawal tree is deleted", () => {
    expect(fs.existsSync(path.join(root, "app/api/withdrawal"))).toBe(false);
  });
});
