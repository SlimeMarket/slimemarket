/**
 * Secret Vault Encryption Utilities (AES-256-GCM)
 * 
 * Encrypts sensitive credentials stored in PostgreSQL secret_vault table.
 * Implements PCI-DSS compliant encryption with key rotation support.
 * 
 * Usage:
 *   const encrypted = encrypt(plaintextCredentials);
 *   await db.insert({ ciphertext: encrypted });
 *   
 *   // On retrieval:
 *   const decrypted = decrypt(encryptedBlob.ciphertext);
 */

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const TAG_LENGTH = 16; // 128 bits

export interface EncryptedBlob {
  iv: string;          // Initialization vector (hex encoded)
  ciphertext: string;  // Encrypted data (hex encoded)
  tag: string;         // Authentication tag for GCM mode (hex encoded)
}

/**
 * Get encryption key from environment or AWS KMS/HSM
 * 
 * SECURITY REQUIREMENT: Never store encryption keys in plaintext!
 * Use AWS KMS, HashiCorp Vault, or similar HSM service in production.
 * For development/testing only: ENCRYPTION_KEY must be set as hex string.
 */
export function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  
  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY not configured.\n' +
      'Production: Use AWS KMS or HashiCorp Vault\n' +
      'Development: Export ENCRYPTION_KEY=<64-char-hex-string>\n' +
      'Example: export ENCRYPTION_KEY=' + 
        '`' + crypto.randomBytes(KEY_LENGTH).toString('hex') + '`'
    );
  }
  
  // Validate key is correct length (32 bytes = 64 hex chars)
  if (key.length !== KEY_LENGTH * 2) {
    throw new Error(
      `Invalid encryption key length: expected ${KEY_LENGTH * 2} characters, got ${key.length}`
    );
  }
  
  return Buffer.from(key, 'hex');
}

/**
 * Encrypt plaintext using AES-256-GCM authenticated encryption
 * 
 * @param plaintext - Raw credential string to encrypt
 * @returns JSON object containing iv, ciphertext, and tag
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  const blob: EncryptedBlob = {
    iv: iv.toString('hex'),
    ciphertext: encrypted,
    tag: authTag.toString('hex')
  };
  
  return JSON.stringify(blob);
}

/**
 * Decrypt ciphertext using AES-256-GCM authenticated decryption
 * 
 * Validates authentication tag to detect tampering.
 * 
 * @param encryptedJson - JSON object from encrypt() output
 * @returns Decrypted plaintext string
 * @throws Error if authentication fails (tampered data)
 */
export function decrypt(encryptedJson: string): string {
  const key = getEncryptionKey();
  
  let blob: EncryptedBlob;
  try {
    blob = JSON.parse(encryptedJson);
  } catch (e) {
    throw new Error(`Invalid encrypted data format: ${(e as Error).message}`);
  }
  
  const { iv, ciphertext, tag } = blob;
  
  // Validate required fields
  if (!iv || !ciphertext || !tag) {
    throw new Error('Encrypted data missing required fields (iv, ciphertext, or tag)');
  }
  
  const ivBuffer = Buffer.from(iv, 'hex');
  const authTagBuffer = Buffer.from(tag, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuffer);
  decipher.setAuthTag(authTagBuffer);
  
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Version the encryption key by generating a new one
 * 
 * Use this when implementing key rotation every 90 days.
 * Returns oldKey, newKey, and migration instructions.
 */
export function generateNewEncryptionKey(): {
  oldKey: string;
  newKey: string;
  instructions: string[];
} {
  const oldKey = process.env.ENCRYPTION_KEY || '';
  
  if (!oldKey) {
    throw new Error('Cannot generate new key without existing key for comparison');
  }
  
  const newKey = crypto.randomBytes(KEY_LENGTH).toString('hex');
  
  return {
    oldKey,
    newKey,
    instructions: [
      '1. Set ENCRYPTION_KEY env var to newKey temporarily',
      '2. Update all database records by re-encrypting with new key',
      '3. Verify oldKey still works for any legacy data',
      '4. After migration complete, remove oldKey reference',
      '5. Store oldKey securely for rollback (delete after 30 days)'
    ]
  };
}

/**
 * Create HMAC-SHA256 for integrity verification
 * 
 * Used for verifying webhook signatures, request authentication, etc.
 */
export function createHmacSha256(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Timing-safe comparison for secrets/pins
 * 
 * Prevents timing attacks on secret comparisons.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Sanitize sensitive fields from error objects/logging
 * 
 * Prevents accidental leakage of credentials in logs.
 */
export function sanitizeSensitiveFields(obj: any): any {
  const sensitiveKeys = ['password', 'secret', 'private_key', 'api_key', 'token'];
  
  const sanitized = { ...obj };
  
  for (const [key, value] of Object.entries(sanitized)) {
    const lowerKey = key.toLowerCase();
    
    if (sensitiveKeys.some(s => lowerKey.includes(s))) {
      (sanitized as any)[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      (sanitized as any)[key] = sanitizeSensitiveFields(value);
    }
  }
  
  return sanitized;
}
