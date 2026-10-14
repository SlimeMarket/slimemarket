import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Webhook notification types must be real Circle `NotificationType` values.
 *
 * WHAT HAPPENED: `/api/webhooks/circle` matched inbound top-ups against
 *
 *     new Set(["payments", "wallets/transactions"])
 *
 * Neither string exists in Circle's enum. Circle sends `transactions.inbound`.
 * So `isTopup` was never true, every inbound transfer fell through to the
 * "unhandled notificationType" log, and **no top-up was ever credited** — a
 * silent, total failure of the inbound rail that no test covered.
 *
 * A made-up type string is invisible at every other layer: the subscription API
 * accepts it, the endpoint returns 200, and the handler logs a tidy message. The
 * only thing that catches it is comparing against Circle's own enum — which is
 * what this test does, straight from the installed SDK so it cannot drift.
 */

const ROOT = join(__dirname, "..", "..");

/** The NotificationType enum as declared by the installed Circle SDK. */
function circleNotificationTypes(): Set<string> {
  const p = join(
    ROOT,
    "node_modules",
    "@circle-fin",
    "developer-controlled-wallets",
    "dist",
    "types",
    "clients",
    "configurations.d.ts",
  );
  const src = readFileSync(p, "utf8");
  const block = src.match(/declare const NotificationType:\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error("NotificationType enum not found in the Circle SDK");
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

/** The strings inside the handler's SETTLED_TRANSFER_TYPES set. */
function handlerTopupTypes(): string[] {
  const src = readFileSync(join(ROOT, "app", "api", "webhooks", "circle", "route.ts"), "utf8");
  const block = src.match(/const SETTLED_TRANSFER_TYPES = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error("SETTLED_TRANSFER_TYPES not found in the webhook handler");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("circle webhook notification types", () => {
  it("uses only values that exist in Circle's NotificationType enum", () => {
    const valid = circleNotificationTypes();
    const used = handlerTopupTypes();

    expect(used.length, "TOPUP_CONFIRMATION_TYPES is empty").toBeGreaterThan(0);
    expect(
      valid.size,
      "failed to read the NotificationType enum from the SDK — the assertion below would be vacuous",
    ).toBeGreaterThan(10);

    const bogus = used.filter((t) => !valid.has(t));
    expect(
      bogus,
      `These notification types are not in Circle's enum, so they can never arrive:\n` +
        bogus.map((b) => `  ${b}`).join("\n") +
        `\nCircle sends: ${[...valid].filter((v) => v.startsWith("transactions")).join(", ")}`,
    ).toEqual([]);
  });

  it("matches the inbound-transfer type Circle actually sends", () => {
    // Named explicitly: this is the exact string that was missing.
    expect(handlerTopupTypes()).toContain("transactions.inbound");
  });

  it("no longer carries the two invented strings", () => {
    // Strip comments first: the fix's own doc block quotes the bogus strings,
    // and a raw `not.toContain` would match the explanation rather than code.
    const src = readFileSync(join(ROOT, "app", "api", "webhooks", "circle", "route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(src).not.toContain('"wallets/transactions"');
    // `payments` must not be a set member either.
    expect(handlerTopupTypes()).not.toContain("payments");
  });

  it("recovers an MSYS-mangled --path argument", () => {
    // Git Bash rewrites `/api/webhooks/circle` into
    // `C:/Program Files/Git/api/webhooks/circle`, which created a subscription
    // for a nonsense endpoint (Circle answered 400). Pull the real function out
    // of the script and run it, rather than asserting on its source text.
    const src = readFileSync(join(ROOT, "scripts", "setup-webhook-subscription.mjs"), "utf8");
    const block = src.match(/function normalisePath\([\s\S]*?\n\}/);
    if (!block) throw new Error("normalisePath not found in the setup script");
    const normalisePath = new Function(`${block[0]}; return normalisePath;`)() as (
      raw: string | null,
    ) => string | null;

    // Exactly what Git Bash hands over on Windows:
    expect(normalisePath("C:/Program Files/Git/api/webhooks/circle")).toBe(
      "/api/webhooks/circle",
    );
    // Unmangled input is untouched.
    expect(normalisePath("/api/webhooks/escrow")).toBe("/api/webhooks/escrow");
    expect(normalisePath(null)).toBeNull();
  });
});
