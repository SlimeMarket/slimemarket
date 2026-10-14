/**
 * Reset an admin's PIN hash to the scrypt format expected by
 * lib/admin-auth.ts (`salt:hexhash`, scrypt N=16384 r=8 p=1 keylen=64).
 *
 * This replaces the rogue scripts/reset-admin-pin.js, which wrote a
 * PBKDF2 value disguised as an "argon2$..." string that verifyPin()
 * could never parse (no ":" separator) — so every PIN attempt failed.
 *
 * Usage:
 *   npx tsx scripts/reset-admin-pin.ts <PIN> [email]
 *   RESET_PIN=<PIN> npx tsx scripts/reset-admin-pin.ts [email]
 *
 * Prints the generated hash and the exact SQL UPDATE to apply. The PIN is
 * never hardcoded here and the hash is never written to any repo file —
 * apply it to the DB directly (e.g. via docker psql).
 */

import { hashPin } from "@/lib/admin-auth";

const pin = process.argv[2] ?? process.env.RESET_PIN;
const email = process.argv[3] ?? process.env.RESET_EMAIL ?? "bintang7paa@gmail.com";

if (!pin) {
  console.error("Error: PIN missing. Usage: npx tsx scripts/reset-admin-pin.ts <PIN> [email]");
  console.error("   or: RESET_PIN=<PIN> npx tsx scripts/reset-admin-pin.ts [email]");
  process.exit(1);
}

const hash = await hashPin(pin);

console.log("Generated scrypt PIN hash (salt:hex, 161 chars):");
console.log(hash);
console.log("");
console.log("Apply with:");
console.log(
  `docker exec supabase_db_slimemarket psql -U postgres -d postgres -c ` +
    `"UPDATE users SET admin_pin_hash='${hash}', pin_attempts=0, pin_locked_until=NULL WHERE email='${email}';"`
);
