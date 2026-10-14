import { describe, expect, it, vi } from "vitest";
import { clientErrorMessage, dbErrorMessage } from "@/lib/utils";

/**
 * Error responses must not leak driver internals to the client, but must not
 * swallow the app's own user-facing messages either.
 *
 * Before: routes returned `e.message` verbatim, so Postgres text such as
 * `duplicate key value violates unique constraint "users_email_key"` reached
 * the caller — a free schema map for anyone probing the API.
 *
 * The tempting over-correction is "always return a generic string". That is
 * wrong here: lib/wl/transitions.ts alone throws 69 user-facing errors and only
 * 6 carry a marker, so it would silently replace ~63 real explanations
 * ("insufficient on-chain balance: have 0.27, need 0.56") with "request failed".
 */

describe("clientErrorMessage — driver errors are withheld", () => {
  it("hides a raw PostgREST error (details/hint shape)", () => {
    const e = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "users_email_key"',
      details: "Key (email)=(a@b.c) already exists.",
      hint: null,
    };
    expect(clientErrorMessage(e, "database error")).toBe("database error");
  });

  it("hides an error carrying a SQLSTATE code", () => {
    expect(clientErrorMessage({ code: "42501", message: "permission denied for table users" }, "nope")).toBe("nope");
  });

  it("hides a Circle-style numeric code", () => {
    expect(clientErrorMessage({ code: 155105, message: "Circle user token invalid" }, "nope")).toBe("nope");
  });

  it("hides driver text WRAPPED into a plain Error", () => {
    // `throw new Error(`create_wl_deal: ${rpcErr.message}`)` — the shape is an
    // ordinary Error, so only the content gives it away.
    const e = new Error('create_wl_deal: new row violates check constraint "wl_deals_status_check"');
    expect(clientErrorMessage(e, "create deal failed")).toBe("create deal failed");
  });

  it.each([
    'relation "secret_table" does not exist',
    'column "internal_note" does not exist',
    "syntax error at or near \"selct\"",
    'null value in column "buyer_id" violates not-null constraint',
    "new row violates row-level security policy for table \"mm_audit_log\"",
  ])("hides: %s", (msg) => {
    expect(clientErrorMessage(new Error(msg), "failed")).toBe("failed");
  });
});

describe("clientErrorMessage — app errors still reach the caller", () => {
  it("passes a plain app error through", () => {
    expect(clientErrorMessage(new Error("insufficient on-chain balance: have 0.27, need 0.56")))
      .toBe("insufficient on-chain balance: have 0.27, need 0.56");
  });

  it("passes an unmarked transition error through", () => {
    expect(clientErrorMessage(new Error("refund: status must be ESCROW or DISPUTED (got WAITING)")))
      .toBe("refund: status must be ESCROW or DISPUTED (got WAITING)");
  });

  it("always honours an explicit httpStatus marker", () => {
    const e = Object.assign(new Error("deal was delivered; use the confirmation path"), { httpStatus: 409 });
    expect(clientErrorMessage(e)).toBe("deal was delivered; use the confirmation path");
  });

  it("falls back for a non-error throw", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(clientErrorMessage("boom", "failed")).toBe("failed");
    spy.mockRestore();
  });
});

describe("dbErrorMessage", () => {
  it("returns a generic message and logs the detail", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = dbErrorMessage("admin/mm", { message: 'violates check constraint "x"' });
    expect(out).toBe("database error");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
