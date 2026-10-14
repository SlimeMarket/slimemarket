/**
 * CSRF origin-acceptance decision tests (.C).
 *
 * Covers the pure helper `isCsrfOriginAllowed` extracted from middleware.ts:
 *  - exact origin match allowed
 *  - dev-loopback mode: when the CONFIGURED origin host is a loopback
 *    (localhost / 127.0.0.1 / ::1), accept any request whose Origin/Referer
 *    (or Host header fallback) is ALSO loopback, on ANY port
 *  - non-loopback configured origins stay STRICT (no loopback relaxation)
 *  - missing Origin → Referer fallback → Host-header fallback semantics
 *  - unset configured origin → allow-all (existing dev behavior)
 */

import { describe, it, expect } from "vitest";
import { isCsrfOriginAllowed } from "@/lib/security/csrf-origin";

describe("isCsrfOriginAllowed", () => {
  describe("exact match (non-loopback)", () => {
    it("allows exact origin match", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "https://slimemarket.app",
          requestOrigin: "https://slimemarket.app",
          requestHost: "slimemarket.app",
        }),
      ).toBe(true);
    });

    it("rejects different host", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "https://slimemarket.app",
          requestOrigin: "https://evil.example.com",
          requestHost: "slimemarket.app",
        }),
      ).toBe(false);
    });

    it("rejects port mismatch on strict origin", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "https://slimemarket.app",
          requestOrigin: "https://slimemarket.app:8443",
          requestHost: "slimemarket.app",
        }),
      ).toBe(false);
    });
  });

  describe("dev-loopback mode (allowed origin host is loopback)", () => {
    const allowed = "http://localhost:3000";

    it("localhost ↔ localhost across ports", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: allowed,
          requestOrigin: "http://localhost:3007",
          requestHost: "localhost:3007",
        }),
      ).toBe(true);
    });

    it("127.0.0.1 origin accepted when allowed is localhost (THE BUG)", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: allowed,
          requestOrigin: "http://127.0.0.1:3007",
          requestHost: "127.0.0.1:3007",
        }),
      ).toBe(true);
    });

    it("localhost origin accepted when allowed is 127.0.0.1", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "http://127.0.0.1:3000",
          requestOrigin: "http://localhost:3006",
          requestHost: "localhost:3006",
        }),
      ).toBe(true);
    });

    it("::1 origin accepted (bracketed URL form)", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: allowed,
          requestOrigin: "http://[::1]:3007",
          requestHost: "[::1]:3007",
        }),
      ).toBe(true);
    });

    it("loopback allowed origin accepts ::1 configured origin too", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "http://[::1]:3000",
          requestOrigin: "http://127.0.0.1:3007",
          requestHost: "127.0.0.1:3007",
        }),
      ).toBe(true);
    });

    it("still rejects non-loopback origins in loopback mode", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: allowed,
          requestOrigin: "http://evil.example.com",
          requestHost: "localhost:3007",
        }),
      ).toBe(false);
    });

    it("lookalike hosts are NOT loopback", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: allowed,
          requestOrigin: "http://localhost.evil.com:3007",
          requestHost: "localhost:3007",
        }),
      ).toBe(false);
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: allowed,
          requestOrigin: "http://127.0.0.1.evil.com:3007",
          requestHost: "localhost:3007",
        }),
      ).toBe(false);
    });
  });

  describe("non-loopback allowed origin does NOT relax for loopback", () => {
    it("rejects localhost origin when allowed is a real domain", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "https://slimemarket.app",
          requestOrigin: "http://localhost:3007",
          requestHost: "localhost:3007",
        }),
      ).toBe(false);
    });

    it("rejects 127.0.0.1 host header when allowed is a real domain", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "https://slimemarket.app",
          requestOrigin: null,
          requestHost: "127.0.0.1:3007",
        }),
      ).toBe(false);
    });
  });

  describe("missing origin fallbacks", () => {
    it("falls back to Referer when Origin absent", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "https://slimemarket.app",
          requestOrigin: null,
          requestReferer: "https://slimemarket.app/checkout?x=1",
          requestHost: "slimemarket.app",
        }),
      ).toBe(true);
    });

    it("rejects foreign Referer when Origin absent", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "https://slimemarket.app",
          requestOrigin: null,
          requestReferer: "https://evil.example.com/pwn",
          requestHost: "slimemarket.app",
        }),
      ).toBe(false);
    });

    it("loopback mode: loopback Host header passes with no Origin/Referer", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "http://localhost:3000",
          requestOrigin: null,
          requestHost: "127.0.0.1:3007",
        }),
      ).toBe(true);
    });

    it("no Origin/Referer and non-loopback allowed origin → reject (strict Host compare)", () => {
      // Host-header fallback compares host NAMES, not full origins — so the
      // same-named host passes even though no Origin header matched.
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "https://slimemarket.app",
          requestOrigin: null,
          requestHost: "slimemarket.app",
        }),
      ).toBe(true);
    });

    it("malformed Referer does not throw; Host fallback applies", () => {
      // Old middleware would THROW on a malformed Referer. The helper treats
      // it as absent and uses the Host fallback (same-named host → pass).
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "https://slimemarket.app",
          requestOrigin: null,
          requestReferer: "not a url",
          requestHost: "slimemarket.app",
        }),
      ).toBe(true);
    });
  });

  describe("unset configured origin", () => {
    it("allow-all when NEXT_PUBLIC_APP_URL is unset", () => {
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: undefined,
          requestOrigin: "http://anything.example.com",
          requestHost: "anything.example.com",
        }),
      ).toBe(true);
      expect(
        isCsrfOriginAllowed({
          allowedOrigin: "",
          requestOrigin: null,
          requestHost: null,
        }),
      ).toBe(true);
    });
  });
});
