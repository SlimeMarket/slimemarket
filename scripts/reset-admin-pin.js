#!/usr/bin/env node
/**
 * DEPRECATED — this script previously wrote the admin PIN hash as a
 * PBKDF2 value disguised as an "argon2$..." string, which lib/admin-auth.ts
 * verifyPin() can never parse (it expects scrypt output shaped
 * `<salt hex>:<derived-key hex>`). Running it broke PIN login for the
 * master admin entirely.
 *
 * It no longer touches the database. To reset an admin PIN use:
 *
 *   npx tsx scripts/reset-admin-pin.ts <PIN> [email]
 *
 * which generates the correct scrypt hash and prints the SQL UPDATE.
 */
console.error(
  "scripts/reset-admin-pin.js is deprecated and no longer writes to the DB.\n" +
    "Use instead: npx tsx scripts/reset-admin-pin.ts <PIN> [email]"
);
process.exit(1);
