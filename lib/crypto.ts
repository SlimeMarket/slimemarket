import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { Hex } from "viem";

/**
 * Envelope encryption for SecretVault (P0-6).
 *
 * Layout (base64-encoded, single string, safe for a text column):
 *   v1:<dek_iv_hex>:<wrapped_dek_hex>:<ct_iv_hex>:<ct_hex>
 *
 *   - KEK (key-encryption key) derived from env VALET_KEK_HEX (32-byte hex).
 *   - DEK (data-encryption key) is random per secret, AES-256-GCM.
 *   - DEK wrapped by KEK (AES-256-GCM with separate IV).
 *   - Ciphertext encrypted by DEK (AES-256-GCM with separate IV).
 *   - Both GCM tags appended to their respective ciphertexts (last 16 bytes).
 */

const VERSION = "v1";
const KEY_LEN = 32;
const GCM_TAG_LEN = 16;

function getKek(): Buffer {
  const hex = process.env.VALET_KEK_HEX;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "VALET_KEK_HEX must be a 32-byte hex string (64 chars). Generate with: openssl rand -hex 32"
    );
  }
  // Derive a stable KEK from the configured secret. scrypt adds brute-force cost.
  return scryptSync(hex, "slimemarket-vault-v1", KEY_LEN);
}

function gcmEncrypt(key: Buffer, plaintext: Buffer): { iv: Buffer; ct: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ct: Buffer.concat([ct, tag]) };
}

function gcmDecrypt(key: Buffer, iv: Buffer, ctWithTag: Buffer): Buffer {
  if (ctWithTag.length < GCM_TAG_LEN) {
    throw new Error("gcmDecrypt: ciphertext too short (missing GCM tag)");
  }
  const ct = ctWithTag.subarray(0, ctWithTag.length - GCM_TAG_LEN);
  const tag = ctWithTag.subarray(ctWithTag.length - GCM_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Encrypt a secret string. Returns a single self-contained token.
 * Store this in SecretVault.ciphertext.
 */
export function encryptSecret(plaintext: string): string {
  const kek = getKek();
  const dek = randomBytes(KEY_LEN);
  const { iv: dekIv, ct: wrappedDek } = gcmEncrypt(kek, dek);
  const { iv: ctIv, ct: ctBody } = gcmEncrypt(dek, Buffer.from(plaintext, "utf8"));
  return [
    VERSION,
    dekIv.toString("hex"),
    wrappedDek.toString("hex"),
    ctIv.toString("hex"),
    ctBody.toString("hex"),
  ].join(":");
}

/** Decrypt a token produced by encryptSecret. */
export function decryptSecret(token: string): string {
  const parts = token.split(":");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("decryptSecret: malformed token");
  }
  const [, dekIvHex, wrappedDekHex, ctIvHex, ctHex] = parts;
  const kek = getKek();
  const dek = gcmDecrypt(kek, Buffer.from(dekIvHex, "hex"), Buffer.from(wrappedDekHex, "hex"));
  const plaintext = gcmDecrypt(dek, Buffer.from(ctIvHex, "hex"), Buffer.from(ctHex, "hex"));
  return plaintext.toString("utf8");
}

/** Convenience: encrypt a structured credentials object (JSON). */
export function encryptCredentials(creds: Record<string, string>): string {
  return encryptSecret(JSON.stringify(creds));
}

/** Convenience: decrypt credentials back to an object. Empty object if token is empty. */
export function decryptCredentials(token: string | null | undefined): Record<string, string> {
  if (!token) return {};
  try {
    return JSON.parse(decryptSecret(token)) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Type guard for the ref kind enum stored in SecretVault. */
export type SecretKind = "credential" | "seed" | "2fa";

/** Cast helper for viem Hex (used by address validation upstream). */
export function toHex(s: string): Hex {
  return s as Hex;
}
