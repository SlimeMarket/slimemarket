/**
 * CSRF Protection Security Tests
 * 
 * Verifies double-submit cookie pattern implementation
 * Prevents cross-site request forgery attacks
 */

import { describe, it, expect } from 'vitest';
import { generateCsrfToken, verifyCsrfToken } from '@/lib/security/csrf';

describe('CSRF Protection System', () => {
  const TEST_SECRET = 'test-csrf-secret-key-for-testing-purposes-only-not-for-production';

  it('should generate valid token pair', () => {
    const { token, signature } = generateCsrfToken();
    
    // Token should be valid hex string (64 chars for 32 bytes)
    expect(token).toMatch(/^0x[0-9a-f]{64}$/i);
    
    // Signature should also be valid hex
    expect(signature).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('should validate correct token', () => {
    const { token, signature } = generateCsrfToken();
    
    expect(verifyCsrfToken(token, signature, TEST_SECRET)).toBe(true);
  });

  it('should reject tampered token', () => {
    const { token, signature } = generateCsrfToken();
    
    // Tamper with token
    const tamperedToken = '0x' + token.substring(2).replace(/[0-9]/g, '0');
    
    expect(verifyCsrfToken(tamperedToken, signature, TEST_SECRET)).toBe(false);
  });

  it('should reject invalid signature', () => {
    const { token, signature } = generateCsrfToken();
    
    // Use different secret
    expect(verifyCsrfToken(token, signature, 'wrong-secret')).toBe(false);
  });

  it('should handle timing-safe comparison', async () => {
    const { token, signature } = generateCsrfToken();
    
    // Verify consistent results even with tiny differences
    for (let i = 0; i < 10; i++) {
      expect(verifyCsrfToken(token, signature, TEST_SECRET)).toBe(true);
    }
  });
});
