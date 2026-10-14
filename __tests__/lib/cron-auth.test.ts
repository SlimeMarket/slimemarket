import { describe, it, expect } from "vitest";
import {
  safeCronSecretMatch,
  cronSecretFromRequest,
  isCronSecretAuthorized,
} from "@/lib/utils/cron-auth";

/**
 * .F-fix — cron auth hardening:
 *   - Vercel's scheduler sends NO Authorization header (cron entries get a
 *     plain GET/POST), so routes must also accept `?cron_secret=<secret>`.
 *   - The old `bearer === secret` compare is timing-unsafe; the comparison
 *     must go through crypto.timingSafeEqual over equal-length digests.
 *   - `x-vercel-cron` alone is NEVER sufficient (spoofable off-Vercel).
 */

describe("safeCronSecretMatch — timing-safe compare", () => {
  it("returns true on an exact match", () => {
    expect(safeCronSecretMatch("sm_dev_cron_secret", "sm_dev_cron_secret")).toBe(true);
  });

  it("returns false on a mismatch", () => {
    expect(safeCronSecretMatch("sm_dev_cron_secret", "sm_dev_cron_secreX")).toBe(false);
  });

  it("returns false when the presented secret is empty", () => {
    expect(safeCronSecretMatch("sm_dev_cron_secret", "")).toBe(false);
  });

  it("returns false when the expected secret is empty (unset secret never authenticates)", () => {
    expect(safeCronSecretMatch("", "sm_dev_cron_secret")).toBe(false);
  });

  it("returns false when either side is undefined/null", () => {
    expect(safeCronSecretMatch(undefined, "sm_dev_cron_secret")).toBe(false);
    expect(safeCronSecretMatch("sm_dev_cron_secret", undefined)).toBe(false);
    expect(safeCronSecretMatch(null, "sm_dev_cron_secret")).toBe(false);
    expect(safeCronSecretMatch("sm_dev_cron_secret", null)).toBe(false);
    expect(safeCronSecretMatch(undefined, undefined)).toBe(false);
  });

  it("returns false for different-length inputs", () => {
    expect(safeCronSecretMatch("short", "much-longer-secret-value")).toBe(false);
    expect(safeCronSecretMatch("much-longer-secret-value", "short")).toBe(false);
  });

  it("matches long secrets correctly", () => {
    const long = "x".repeat(1024);
    expect(safeCronSecretMatch(long, long)).toBe(true);
    expect(safeCronSecretMatch(long, long.slice(0, 1023) + "y")).toBe(false);
  });
});

describe("cronSecretFromRequest — bearer header OR ?cron_secret= query", () => {
  it("extracts the secret from an Authorization: Bearer header", () => {
    const req = new Request("http://localhost/api/admin/auto-release", {
      headers: { authorization: "Bearer topsecret" },
      method: "POST",
    });
    expect(cronSecretFromRequest(req)).toBe("topsecret");
  });

  it("extracts the secret from the cron_secret query param (Vercel scheduler path)", () => {
    const req = new Request("http://localhost/api/admin/auto-release?cron_secret=topsecret", {
      method: "POST",
    });
    expect(cronSecretFromRequest(req)).toBe("topsecret");
  });

  it("prefers the bearer header when both are present", () => {
    const req = new Request("http://localhost/api/admin/auto-release?cron_secret=queryval", {
      headers: { authorization: "Bearer headerval" },
      method: "POST",
    });
    expect(cronSecretFromRequest(req)).toBe("headerval");
  });

  it("returns empty string when neither is present", () => {
    const req = new Request("http://localhost/api/admin/auto-release", { method: "POST" });
    expect(cronSecretFromRequest(req)).toBe("");
  });

  it("returns empty string for a bare 'Bearer' with no token", () => {
    const req = new Request("http://localhost/api/admin/auto-release", {
      headers: { authorization: "Bearer " },
      method: "POST",
    });
    expect(cronSecretFromRequest(req)).toBe("");
  });
});

describe("isCronSecretAuthorized — combined route decision", () => {
  const SECRET = "sm_dev_cron_secret_2026";

  it("true for a matching bearer header", () => {
    const req = new Request("http://localhost/api/admin/indexer/run", {
      headers: { authorization: `Bearer ${SECRET}` },
      method: "POST",
    });
    expect(isCronSecretAuthorized(req, SECRET)).toBe(true);
  });

  it("true for a matching cron_secret query param", () => {
    const req = new Request(`http://localhost/api/admin/indexer/run?cron_secret=${SECRET}`, {
      method: "POST",
    });
    expect(isCronSecretAuthorized(req, SECRET)).toBe(true);
  });

  it("false for a wrong secret", () => {
    const req = new Request("http://localhost/api/admin/indexer/run?cron_secret=WRONG", {
      method: "POST",
    });
    expect(isCronSecretAuthorized(req, SECRET)).toBe(false);
  });

  it("false when the x-vercel-cron header is present but no secret (header alone is spoofable)", () => {
    const req = new Request("http://localhost/api/admin/indexer/run", {
      headers: { "x-vercel-cron": "1" },
      method: "POST",
    });
    expect(isCronSecretAuthorized(req, SECRET)).toBe(false);
  });

  it("false when no INDEXER_CRON_SECRET is configured (fail closed)", () => {
    const req = new Request("http://localhost/api/admin/indexer/run?cron_secret=anything", {
      method: "POST",
    });
    expect(isCronSecretAuthorized(req, undefined)).toBe(false);
    expect(isCronSecretAuthorized(req, "")).toBe(false);
  });
});
