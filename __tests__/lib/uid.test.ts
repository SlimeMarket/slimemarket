import { describe, it, expect } from "vitest";
import { UID_ALPHABET, UID_LENGTH, genUid, shortenUid } from "@/lib/uid";

describe("lib/uid", () => {
  it("exposes the ambiguity-free alphabet (no I/L/O/U)", () => {
    expect(UID_ALPHABET).toBe("ABCDEFGHJKMNPQRSTVWXYZ0123456789");
    // 22 letters (26 minus I/L/O/U) + 10 digits = 32 distinct chars.
    expect(UID_ALPHABET.length).toBe(32);
    expect(new Set(UID_ALPHABET).size).toBe(32);
  });

  it("UID_LENGTH is 4 (1,048,576 combinations)", () => {
    expect(UID_LENGTH).toBe(4);
    expect(32 ** 4).toBe(1_048_576);
  });

  it("genUid produces 4-char strings of alphabet chars", () => {
    for (let i = 0; i < 500; i++) {
      const uid = genUid();
      expect(uid).toHaveLength(4);
      for (const ch of uid) expect(UID_ALPHABET).toContain(ch);
    }
  });

  it("genUid is random (not all identical across many draws)", () => {
    const seen = new Set(Array.from({ length: 100 }, () => genUid()));
    expect(seen.size).toBeGreaterThan(50);
  });

  it("shortenUid takes the first 4 chars (backfill helper)", () => {
    expect(shortenUid("6T3P50CJ")).toBe("6T3P");
    expect(shortenUid("6T3P")).toBe("6T3P");
  });

  it("shortenUid rejects short input", () => {
    expect(() => shortenUid("6T3")).toThrow();
  });
});
