import { describe, it, expect } from "vitest";
import { hashPin, verifyPin } from "@/lib/admin-auth";

/**
 * Regression pins for the master-admin PIN bug (.B).
 *
 * lib/admin-auth.ts stores admin PIN hashes as scrypt output in the shape
 *   `<salt hex>:<derived-key hex>`  (16-byte salt -> 32 hex chars,
 *   64-byte key   -> 128 hex chars, total 161 chars, colon at index 32).
 *
 * verifyPin() splits on ":" and returns false when the stored value has no
 * colon. The bug this pins: rogue scripts wrote a PBKDF2 value disguised as
 * "argon2$..." (no colon), so verifyPin ALWAYS returned false for the real
 * master PIN -> "Invalid PIN" even when the PIN was correct.
 */

// Exact shape of a valid hashPin() output:
//   salt = crypto.randomBytes(16).toString("hex")  -> 32 lowercase hex chars
//   key  = scrypt(keylen 64).toString("hex")       -> 128 lowercase hex chars
const PIN_HASH_SHAPE = /^[a-f0-9]{32}:[a-f0-9]{128}$/;

describe("admin PIN scrypt hash/verify", () => {
  it("verifyPin returns true for the correct PIN against its own hash", async () => {
    const stored = await hashPin("090921");
    await expect(verifyPin("090921", stored)).resolves.toBe(true);
  });

  it("verifyPin returns false for a wrong PIN", async () => {
    const stored = await hashPin("090921");
    await expect(verifyPin("000000", stored)).resolves.toBe(false);
  });

  it("hashPin output matches the salt:hex scrypt shape (161 chars, colon at idx 32)", async () => {
    const stored = await hashPin("090921");
    expect(stored).toMatch(PIN_HASH_SHAPE);
    expect(stored).toHaveLength(161);
    expect(stored.indexOf(":")).toBe(32);
    // Salt must be random per call (never reuse a salt).
    const second = await hashPin("090921");
    expect(second).not.toBe(stored);
    expect(second.split(":")[0]).not.toBe(stored.split(":")[0]);
  });

  it("verifyPin returns false (never throws) for a malformed stored hash with no colon", async () => {
    // PBKDF2-disguised-as-argon2 format written by the rogue scripts — no ":".
    const rogue =
      "argon2$v=19$m=65536,t=3$p=abcdef0123456789abcdef0123456789$" +
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    await expect(verifyPin("090921", rogue)).resolves.toBe(false);
  });

  it("verifyPin returns false (never throws) for an empty string", async () => {
    await expect(verifyPin("090921", "")).resolves.toBe(false);
  });
});
