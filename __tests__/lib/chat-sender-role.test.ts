import { describe, expect, it } from "vitest";
import { toSenderRole, resolveDealSenderRole } from "@/lib/wl/chat";

/**
 * Regression: `users.role` is Member | MM | Buyer | Seller | Admin, but
 * `chat_messages.sender_role` has a CHECK constraint (migration 0035) that
 * only accepts buyer | seller | middleman | system | admin.
 *
 * Lowercasing the account role produced "member" (the DEFAULT signup role!)
 * and "mm", so posting a chat/forum message blew up with:
 *   new row for relation "chat_messages" violates check constraint
 *   "chat_messages_sender_role_check"
 *
 * Live impact before the fix: 6 of 12 seeded users were "Member" and 1 was
 * "MM" — i.e. most users could not send any chat message at all.
 */

/** The only values the DB CHECK constraint accepts. */
const VALID_SENDER_ROLES = ["buyer", "seller", "middleman", "system", "admin"];

describe("toSenderRole", () => {
  it("maps every account role onto a CHECK-valid sender_role", () => {
    for (const role of ["Member", "MM", "Buyer", "Seller", "Admin"]) {
      const mapped = toSenderRole(role);
      expect(VALID_SENDER_ROLES, `${role} -> ${mapped}`).toContain(mapped);
    }
  });

  it("maps the default signup role Member to buyer (was 'member' → crash)", () => {
    expect(toSenderRole("Member")).toBe("buyer");
    expect(toSenderRole("member")).toBe("buyer");
  });

  it("maps MM to middleman (was 'mm' → crash)", () => {
    expect(toSenderRole("MM")).toBe("middleman");
    expect(toSenderRole("mm")).toBe("middleman");
  });

  it("passes through the already-valid roles unchanged", () => {
    expect(toSenderRole("Buyer")).toBe("buyer");
    expect(toSenderRole("Seller")).toBe("seller");
    expect(toSenderRole("Admin")).toBe("admin");
    expect(toSenderRole("middleman")).toBe("middleman");
    expect(toSenderRole("system")).toBe("system");
  });

  it("never returns a value the DB would reject, for junk input", () => {
    for (const junk of ["", "   ", "superuser", "root", "Unknown", null, undefined]) {
      expect(VALID_SENDER_ROLES).toContain(toSenderRole(junk as string));
    }
  });
});

describe("resolveDealSenderRole", () => {
  const buyer = "u-buyer";
  const seller = "u-seller";

  it("uses the deal side regardless of account role", () => {
    // Seller-account acting as the deal's buyer is stored as 'buyer'
    expect(
      resolveDealSenderRole({ senderId: buyer, buyerId: buyer, sellerId: seller, accountRole: "Seller" })
    ).toBe("buyer");
    expect(
      resolveDealSenderRole({ senderId: seller, buyerId: buyer, sellerId: seller, accountRole: "Buyer" })
    ).toBe("seller");
  });

  it("maps a non-party Member (admin/MM spectator path) to a valid value", () => {
    const out = resolveDealSenderRole({
      senderId: "stranger", buyerId: buyer, sellerId: seller, accountRole: "Member",
    });
    expect(VALID_SENDER_ROLES).toContain(out);
  });

  it("admits Admin and MM as staff on an escrow thread", () => {
    expect(
      resolveDealSenderRole({ senderId: "staff", buyerId: buyer, sellerId: seller, accountRole: "Admin" })
    ).toBe("admin");
    expect(
      resolveDealSenderRole({ senderId: "staff", buyerId: buyer, sellerId: seller, accountRole: "MM" })
    ).toBe("middleman");
  });

  it("handles null/undefined deal sides without throwing", () => {
    const out = resolveDealSenderRole({
      senderId: "x", buyerId: null, sellerId: undefined, accountRole: "Admin",
    });
    expect(VALID_SENDER_ROLES).toContain(out);
  });
});
