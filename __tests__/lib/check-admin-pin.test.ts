import { describe, it, expect } from "vitest";
import {
  checkAdminPin,
  hashPin,
  ADMIN_PIN_MAX_ATTEMPTS,
  ADMIN_PIN_LOCKOUT_MINUTES,
} from "@/lib/admin-auth";

/**
 * per-action admin PIN re-verification for treasury withdrawals.
 *
 * checkAdminPin() is the PURE decision core used by
 * POST /api/admin/treasury/withdraw BEFORE any treasury movement:
 *   - admin has no PIN set            -> ADMIN_PIN_NOT_SET (409 upstream)
 *   - active lockout                  -> PIN_LOCKED (423 upstream)
 *   - wrong PIN                       -> INVALID_PIN + attemptsRemaining (401 upstream)
 *   - 3rd wrong PIN                   -> escalation to PIN_LOCKED + lockedUntil
 *   - expired lockout                 -> re-allows attempts
 *   - correct PIN                     -> { ok: true, resetAttempts: true }
 */

const NOW = new Date("2026-08-09T12:00:00.000Z");
const FUTURE = new Date("2026-08-09T12:30:00.000Z"); // +30 min: active lock
const PAST = new Date("2026-08-09T11:00:00.000Z"); // -1 h: expired lock

describe("checkAdminPin — pure PIN gate logic", () => {
  it("ADMIN_PIN_NOT_SET when the admin has no stored hash", async () => {
    const res = await checkAdminPin({
      storedHash: null,
      attempts: 0,
      lockedUntil: null,
      pin: "1234",
      now: NOW,
    });
    expect(res).toEqual({ ok: false, code: "ADMIN_PIN_NOT_SET" });
  });

  it("PIN_LOCKED while an active lockout is in force — even for the CORRECT PIN", async () => {
    const stored = await hashPin("090921");
    const res = await checkAdminPin({
      storedHash: stored,
      attempts: 3,
      lockedUntil: FUTURE,
      pin: "090921",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("PIN_LOCKED");
      if (res.code === "PIN_LOCKED") {
        expect(res.lockedUntil).toBe(FUTURE.toISOString());
      }
    }
  });

  it("correct PIN succeeds and signals resetAttempts", async () => {
    const stored = await hashPin("090921");
    const res = await checkAdminPin({
      storedHash: stored,
      attempts: 0,
      lockedUntil: null,
      pin: "090921",
      now: NOW,
    });
    expect(res).toEqual({ ok: true, resetAttempts: true });
  });

  it("wrong PIN with 0 prior attempts -> INVALID_PIN, attemptsRemaining 2", async () => {
    const stored = await hashPin("090921");
    const res = await checkAdminPin({
      storedHash: stored,
      attempts: 0,
      lockedUntil: null,
      pin: "000000",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("INVALID_PIN");
      if (res.code === "INVALID_PIN") {
        expect(res.attemptsRemaining).toBe(ADMIN_PIN_MAX_ATTEMPTS - 1); // 2
      }
    }
  });

  it("wrong PIN with 1 prior attempt -> attemptsRemaining 1", async () => {
    const stored = await hashPin("090921");
    const res = await checkAdminPin({
      storedHash: stored,
      attempts: 1,
      lockedUntil: null,
      pin: "111111",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.code === "INVALID_PIN") {
      expect(res.attemptsRemaining).toBe(1);
    }
  });

  it("3rd wrong PIN escalates to PIN_LOCKED with lockedUntil = now + 15 min", async () => {
    const stored = await hashPin("090921");
    const res = await checkAdminPin({
      storedHash: stored,
      attempts: ADMIN_PIN_MAX_ATTEMPTS - 1, // 2 prior failures
      lockedUntil: null,
      pin: "999999",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("PIN_LOCKED");
      if (res.code === "PIN_LOCKED") {
        const expected = new Date(
          NOW.getTime() + ADMIN_PIN_LOCKOUT_MINUTES * 60_000,
        ).toISOString();
        expect(res.lockedUntil).toBe(expected);
      }
    }
  });

  it("expired lockout re-allows a CORRECT PIN", async () => {
    const stored = await hashPin("090921");
    const res = await checkAdminPin({
      storedHash: stored,
      attempts: 3,
      lockedUntil: PAST, // expired an hour ago
      pin: "090921",
      now: NOW,
    });
    expect(res).toEqual({ ok: true, resetAttempts: true });
  });

  it("expired lockout re-allows a WRONG PIN with a fresh full attempt budget", async () => {
    const stored = await hashPin("090921");
    const res = await checkAdminPin({
      storedHash: stored,
      attempts: 3,
      lockedUntil: PAST,
      pin: "000000",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.code === "INVALID_PIN") {
      // Attempts were reset by the expired lock: one used, two left.
      expect(res.attemptsRemaining).toBe(2);
    }
  });

  it("lockedUntil exactly equal to now is treated as expired (boundary)", async () => {
    const stored = await hashPin("090921");
    const res = await checkAdminPin({
      storedHash: stored,
      attempts: 3,
      lockedUntil: NOW, // expires at exactly `now`
      pin: "090921",
      now: NOW,
    });
    expect(res).toEqual({ ok: true, resetAttempts: true });
  });
});
