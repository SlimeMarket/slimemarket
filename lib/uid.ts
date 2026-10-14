import { randomBytes } from "crypto";

/**
 * 4-char public UID — also used as the Circle UCW userId.
 *
 * Alphabet deliberately excludes I, L (look like 1), O (looks like 0) and U
 * (ambiguity). 32 chars (22 letters + 10 digits) ^ 4 = 1,048,576
 * combinations; collisions are handled by the callers' DB retry loops
 * (users.uid has a UNIQUE constraint).
 */
export const UID_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789"; // no I/L/O/U
export const UID_LENGTH = 4; // 32^4 = 1,048,576 combinations

/** Generate a cryptographically random 4-char UID. */
export function genUid(): string {
  const bytes = randomBytes(UID_LENGTH);
  let s = "";
  for (let i = 0; i < UID_LENGTH; i++) {
    s += UID_ALPHABET[bytes[i] % UID_ALPHABET.length];
  }
  return s;
}

/**
 * First 4 chars of a legacy 8-char UID (backfill helper for migration 0050).
 * Throws if the input is shorter than UID_LENGTH.
 */
export function shortenUid(long: string): string {
  if (!long || long.length < UID_LENGTH) {
    throw new Error(`shortenUid: input shorter than ${UID_LENGTH} chars`);
  }
  return long.slice(0, UID_LENGTH);
}
