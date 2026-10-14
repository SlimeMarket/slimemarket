import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * EMAIL HTML INJECTION (2026-10-06).
 *
 * `sendEmail` used to do `html: args.html ?? args.text` — i.e. whenever a caller
 * supplied only `text`, that text WAS the HTML part.
 *
 * The callers interpolate user-controlled values into `text`:
 *   - the seller's decline reason  (`lib/order/transitions.ts`)
 *   - the dispute resolution reason (`lib/order/disputes.ts`)
 *   - the buyer's appeal reason     (`lib/order/transitions.ts`)
 *
 * So a counterparty could put markup in a reason field and have it render as
 * live HTML in the other party's inbox, inside an email that carries the
 * platform's From/branding — a ready-made phishing vector.
 *
 * Fix: `html` is opt-in. It is never derived from `text`, so those messages are
 * sent as plain text (nodemailer omits the HTML part entirely).
 *
 * 2026-10-13: `sendTemplatedEmail` added as a convenience wrapper that unpacks
 * a pre-built template (subject + text + html). Templates escape all values via
 * `esc()` before interpolation, so the security invariant still holds.
 */
const SRC = fs
  .readFileSync(path.join(process.cwd(), "lib/notif/email.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("sendEmail — never derives the HTML part from `text`", () => {
  it("passes `html` through as-is (no `?? args.text` fallback)", () => {
    expect(SRC, "html must be args.html only").toMatch(/html:\s*args\.html\s*,/);
    expect(SRC, "must NOT fall back to text as HTML").not.toMatch(/args\.html\s*\?\?\s*args\.text/);
  });

  it("still sends the plain-text part", () => {
    expect(SRC).toMatch(/text:\s*args\.text\s*,/);
  });

  it("documents WHY, so the fallback is not reintroduced", () => {
    // The SMTP transport must have exactly one html: key (args.html).
    // sendTemplatedEmail is a wrapper and also references template.html —
    // that's fine because templates escape values before interpolation.
    const smtpSection = SRC.split("function sendViaSmtp")[1]?.split("function ")[0] ?? "";
    const htmlKeys = smtpSection.match(/html:/g) ?? [];
    expect(htmlKeys.length, "only one `html:` assignment in SMTP transport").toBe(1);
  });
});
