/**
 * CSRF (Cross-Site Request Forgery) Protection System
 * 
 * Implements double-submit cookie pattern for mutation endpoints
 * Protects against cross-site request forgery attacks
 * 
 * Usage:
 * 1. Generate token on session creation
 * 2. Include token in all POST/PUT/DELETE/PATCH requests
 * 3. Validate token server-side before processing mutations
 */

import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

interface CsrfTokenPair {
  token: string;
  signature: string;
}

/** Strip a 0x prefix (if present) so hex values hash/compare consistently. */
function strip0x(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

/**
 * Generate CSRF token pair (token + HMAC signature)
 * 
 * Returns both the visible token and its cryptographic signature
 * to prevent timing attacks and token forgery
 */
export function generateCsrfToken(): CsrfTokenPair {
  const token = randomBytes(32).toString('hex');
  const signature = createHmac('sha256', process.env.CSRF_SECRET!).update(token).digest('hex');
  
  return { token: `0x${token}`, signature: `0x${signature}` };
}

/**
 * Verify CSRF token with timing-safe comparison
 * 
 * Prevents timing attacks that could reveal valid tokens
 */
export function verifyCsrfToken(token: string, signature: string, secret: string): boolean {
  const expectedSignature = createHmac('sha256', secret).update(strip0x(token)).digest('hex');
  
  // Timing-safe comparison prevents timing attacks
  const tokenBuffer = Buffer.from(strip0x(signature), 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  
  if (tokenBuffer.length !== expectedBuffer.length) {
    return false;
  }
  
  return timingSafeEqual(tokenBuffer, expectedBuffer);
}

/** Configuration produced by createCsrfMiddleware (paths/methods to protect). */
interface CsrfMiddlewareConfig {
  skipPaths: string[];
  requiredMethods: string[];
}

/**
 * Create CSRF middleware config for Next.js API routes
 * 
 * Defines which paths/methods require CSRF token validation
 */
export function createCsrfMiddleware(options?: { 
  skipPaths?: string[];
  requiredForMethods?: string[];
}): CsrfMiddlewareConfig {
  const skipPaths = options?.skipPaths || [];
  const requiredMethods = options?.requiredForMethods || ['POST', 'PUT', 'DELETE', 'PATCH'];
  
  return { skipPaths, requiredMethods };
}

/**
 * Validate CSRF token from request headers or body
 * 
 * @param request - Next.js request object
 * @param secret - HMAC secret key
 * @returns Token validation result
 */
export async function validateCsrfToken(
  request: NextRequest,
  secret: string
): Promise<{ valid: boolean; error?: string }> {
  const method = request.method.toUpperCase();
  
  // Only check mutation methods
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    return { valid: true };
  }
  
  const csrfToken = request.headers.get('x-csrf-token') || request.headers.get('csrf-token');
  const csrfSignature = request.headers.get('x-csrf-signature') || request.headers.get('csrf-signature');
  
  if (!csrfToken || !csrfSignature) {
    return { 
      valid: false, 
      error: 'CSRF token missing' 
    };
  }
  
  if (!verifyCsrfToken(csrfToken, csrfSignature, secret)) {
    console.warn('[CSRF_VALIDATION_FAILED]', {
      path: request.nextUrl.pathname,
      method,
      timestamp: new Date().toISOString()
    });
    
    return { 
      valid: false, 
      error: 'Invalid CSRF token signature' 
    };
  }
  
  return { valid: true };
}

/**
 * Generate CSRF token cookie settings
 */
export function getCsrfCookieSettings(): {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict';
  maxAge: number;
} {
  const isProd = process.env.NODE_ENV === 'production';
  
  return {
    name: '__csrf_token__',
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 // 24 hours
  };
}

/**
 * Get CSRF token value from request cookies
 */
export function getCsrfTokenFromCookies(cookies: Map<string, string>): string | null {
  return cookies.get('__csrf_token__') || null;
}

/**
 * Create CSRF protection response header
 */
export function createCsrfResponseHeader(cookieName: string, cookieValue: string): Record<string, string> {
  return {
    'Set-Cookie': `${cookieName}=${encodeURIComponent(cookieValue)}; Path=/; SameSite=Strict; HttpOnly; ${process.env.NODE_ENV === 'production' ? 'Secure;' : ''} Max-Age=86400`
  };
}
