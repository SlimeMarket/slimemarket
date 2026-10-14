import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression: POST /api/chats hard-coded the opening message's sender_role.
 *
 *   sender_role: "buyer",   // ← on every thread, regardless of the sender
 *
 * Verified live 2026-09-28: a Seller-account user (`testseller`) created a
 * thread with an `initialMessage`; the stored row came back as
 *   {"sender_id":"4fb6390b…","sender_role":"buyer"}
 * i.e. the SELLER's own opening message was labelled as the BUYER's. Any UI
 * that aligns chat bubbles by sender_role then renders the seller's message as
 * "mine" — the same class of bug as the earlier `toSenderRole` fix, on one of
 * the few paths that fix never touched.
 *
 * Secondary bug on the same lines: the insert result was awaited but its
 * `error` was never checked, so a failed message insert still returned 201 and
 * the caller believed the thread had an opening message.
 *
 * After the fix the same call stores sender_role="seller".
 */
const SRC = fs.readFileSync(
  path.join(process.cwd(), "app/api/chats/route.ts"),
  "utf8",
);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("POST /api/chats — opening message attribution", () => {
  it("does NOT hard-code sender_role to \"buyer\"", () => {
    // The literal must be gone from the insert.
    const inserts = CODE.match(/sender_role:\s*([^,\n]+)/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const s of inserts) {
      expect(s, `hard-coded role: ${s}`).not.toMatch(/sender_role:\s*["']buyer["']/);
    }
  });

  it("derives the role from the sender's account role via toSenderRole", () => {
    expect(CODE).toMatch(/toSenderRole\(user\.role\)/);
    expect(CODE).toMatch(/import\s*\{[^}]*toSenderRole[^}]*\}\s*from\s*["']@\/lib\/wl\/chat["']/);
  });

  it("checks the opening-message insert for an error", () => {
    // The error binding lives on the line BEFORE `from("chat_messages")`, so
    // anchor on a window that starts a bit earlier than the insert itself.
    const anchor = CODE.indexOf('from("chat_messages")');
    const window = CODE.slice(Math.max(0, anchor - 200), anchor + 120);
    expect(window).toMatch(/error:\s*msgErr/);
    expect(CODE).toMatch(/if\s*\(\s*msgErr\s*\)/);
  });

  it("does not silently swallow a failed opening message", () => {
    // A failed insert must surface, not return 201.
    const idx = CODE.indexOf("if (msgErr)");
    expect(idx).toBeGreaterThan(-1);
    expect(CODE.slice(idx, idx + 400)).toMatch(/return jsonError\(/);
  });

  it("still returns the thread id on success", () => {
    expect(CODE).toMatch(/jsonOk\(\{\s*id:\s*thread\.id\s*\}/);
  });

  it("keeps the 400 when participantId is missing", () => {
    expect(CODE).toMatch(/if\s*\(!participantId\)\s*return jsonError\(["']participantId required["'],\s*400\)/);
  });
});
