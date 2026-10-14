import { describe, it, expect, vi, afterEach } from "vitest";
import { sendEmail } from "@/lib/notif/email";

/**
 * Transport selection, pinned.
 *
 * The production VPS cannot open ANY outbound SMTP port — measured:
 *   mail.spacemail.com:25/465/587/2525  → timeout
 *   smtp.gmail.com:25/465               → timeout
 *   smtp-relay.brevo.com:587            → timeout
 *   api.brevo.com:443                   → OK
 *
 * So SMTP silently never delivers in production, and Brevo's HTTP API is the
 * only transport that works. That ordering is a production fact, not a
 * preference — if a future change puts SMTP first again, every platform email
 * goes back to disappearing with a tidy "sent: false".
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(String(url), init));
  });
  return calls;
}

describe("sendEmail transport", () => {
  it("uses the Brevo HTTP API when BREVO_API_KEY is set", async () => {
    vi.stubEnv("BREVO_API_KEY", "xkeysib-test");
    vi.stubEnv("SMTP_FROM", "noreply@slimemarket.app");
    const calls = stubFetch(() => new Response("{}", { status: 201 }));

    const res = await sendEmail({ to: "buyer@example.com", subject: "Invoice", text: "hi" });

    expect(res.sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("xkeysib-test");

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.sender.email).toBe("noreply@slimemarket.app");
    expect(body.to).toEqual([{ email: "buyer@example.com" }]);
    expect(body.subject).toBe("Invoice");
    expect(body.textContent).toBe("hi");
    // No html passed in → must not invent an htmlContent from the text.
    expect(body.htmlContent).toBeUndefined();
  });

  it("passes htmlContent through when a caller supplies html", async () => {
    vi.stubEnv("BREVO_API_KEY", "xkeysib-test");
    const calls = stubFetch(() => new Response("{}", { status: 201 }));

    await sendEmail({ to: "b@e.com", subject: "s", text: "t", html: "<b>t</b>" });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.htmlContent).toBe("<b>t</b>");
  });

  it("reports a failure (never throws) when Brevo rejects the send", async () => {
    vi.stubEnv("BREVO_API_KEY", "xkeysib-bad");
    stubFetch(() => new Response('{"message":"Key not found"}', { status: 401 }));

    const res = await sendEmail({ to: "b@e.com", subject: "s", text: "t" });
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/brevo 401/);
  });

  it("does not call fetch at all when no transport is configured", async () => {
    vi.stubEnv("BREVO_API_KEY", "");
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("SMTP_USER", "");
    vi.stubEnv("SMTP_PASS", "");
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    const res = await sendEmail({ to: "b@e.com", subject: "s", text: "t" });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("no email transport configured");
    expect(calls).toHaveLength(0);
  });

  it("EMAIL_TRANSPORT=smtp still falls back to Brevo instead of dropping mail", async () => {
    // The SMTP-unblock path: once the host allows SMTP egress the operator flips
    // EMAIL_TRANSPORT to smtp. Until then SMTP is unreachable, and mail must
    // still go out — the flag changes the ORDER, it does not disable a fallback.
    vi.stubEnv("EMAIL_TRANSPORT", "smtp");
    vi.stubEnv("BREVO_API_KEY", "xkeysib-test");
    vi.stubEnv("SMTP_HOST", "");
    const calls = stubFetch(() => new Response("{}", { status: 201 }));

    const res = await sendEmail({ to: "b@e.com", subject: "s", text: "t" });
    expect(res.sent).toBe(true);
    expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
  });

  it("EMAIL_TRANSPORT=brevo pins the HTTP API", async () => {
    vi.stubEnv("EMAIL_TRANSPORT", "brevo");
    vi.stubEnv("BREVO_API_KEY", "xkeysib-test");
    vi.stubEnv("SMTP_HOST", ""); // SMTP not configured → never attempted, test stays fast
    const calls = stubFetch(() => new Response('{"message":"nope"}', { status: 401 }));

    const res = await sendEmail({ to: "b@e.com", subject: "s", text: "t" });

    // Brevo is the transport in play, so ITS error is the one reported.
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/brevo 401/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
  });
});
