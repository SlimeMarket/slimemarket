import { describe, it, expect } from "vitest";

/**
 * 3 — MM (middleman) role authorization gates.
 *
 * Routes are not unit-tested in this repo (the __tests__/ suite tests the
 * pure lib cores), so these tests pin the PURE decision helpers the WL
 * routes use: isWlStaff, ROLE_RANK placement of 'MM' (no implicit rank
 * grants), and the admin-action token accepting Admin AND MM roles while
 * still rejecting every other role.
 */

import { isWlStaff, ROLE_RANK } from "@/lib/types";
import { hasRoleAtLeast } from "@/lib/utils";
import { signAdminToken, verifyAdminToken } from "@/lib/admin-auth";

describe("isWlStaff (Admin OR MM)", () => {
  it("accepts Admin and MM", () => {
    expect(isWlStaff("Admin")).toBe(true);
    expect(isWlStaff("MM")).toBe(true);
  });
  it("rejects deal-party / regular roles", () => {
    expect(isWlStaff("Member")).toBe(false);
    expect(isWlStaff("Buyer")).toBe(false);
    expect(isWlStaff("Seller")).toBe(false);
  });
});

describe("ROLE_RANK — MM has no implicit hierarchy grants", () => {
  it("MM does NOT satisfy requireRole-equivalent checks above Member", () => {
    expect(hasRoleAtLeast("MM", "Admin")).toBe(false);
    expect(hasRoleAtLeast("MM", "Seller")).toBe(false);
    expect(hasRoleAtLeast("MM", "Buyer")).toBe(false);
  });
  it("Admin still outranks everything", () => {
    expect(hasRoleAtLeast("Admin", "MM")).toBe(true);
    expect(ROLE_RANK.Admin).toBeGreaterThan(ROLE_RANK.MM);
  });
  it("MM passes the Member floor (any authenticated role)", () => {
    expect(hasRoleAtLeast("MM", "Member")).toBe(true);
  });
});

describe("admin action token — 3 widened to Admin AND MM", () => {
  it("round-trips an Admin token", () => {
    const tok = signAdminToken("user-admin", "Admin");
    expect(verifyAdminToken(tok)).toMatchObject({ sub: "user-admin", role: "Admin" });
  });
  it("round-trips an MM token", () => {
    const tok = signAdminToken("user-mm", "MM");
    expect(verifyAdminToken(tok)).toMatchObject({ sub: "user-mm", role: "MM" });
  });
  it("rejects a token signed with a non-staff role", () => {
    const tok = signAdminToken("user-x", "Seller");
    expect(verifyAdminToken(tok)).toBeNull();
  });
  it("rejects a tampered token", () => {
    const tok = signAdminToken("user-mm", "MM");
    expect(verifyAdminToken(tok.slice(0, -2) + "xx")).toBeNull();
  });
});
