/**
 * The real whatsapp.js and email.js. The rest of the suite mocks the WhatsApp
 * module outright; here the module runs for real with fetch/Resend stubbed, so
 * its message building and failure handling are covered too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WA_ENV = {
  WHATSAPP_TOKEN: "wa-test-token",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  ADMIN_WHATSAPP_NUMBER: "919000000000",
};

const order = {
  orderId: "ORD-1",
  name: "Asha",
  totalAmount: 80752,
  items: Array.from({ length: 7 }, (_, i) => ({ name: `Piece ${i}`, quantity: 1 })),
  shippingAddress: { mobileNumber: "9876543210" },
  approvalStatus: "APPROVED",
  expectedDeliveryDate: new Date("2026-10-12T00:00:00Z"),
};

describe("whatsapp.js (real module)", () => {
  let wa;
  let fetchMock;

  beforeEach(async () => {
    fetchMock = vi.fn(async () => ({ ok: true, text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    wa = await vi.importActual("../../server/utils/whatsapp.js");
  });

  afterEach(() => {
    for (const k of Object.keys(WA_ENV)) delete process.env[k];
  });

  it("no-ops and returns false when unconfigured — never calls the network", async () => {
    expect(await wa.sendOrderAlert({ order, paymentMethod: "cod" })).toBe(false);
    expect(await wa.sendWhatsAppAlert({ customerName: "A", customerMobile: "9", productName: "P" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the Graph API with the bearer token when configured", async () => {
    Object.assign(process.env, WA_ENV);
    expect(await wa.sendOrderAlert({ order, paymentMethod: "cod" })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v18.0/1234567890/messages");
    expect(init.headers.Authorization).toBe("Bearer wa-test-token");
    const body = JSON.parse(init.body);
    expect(body.to).toBe("919000000000");
    expect(body.text.body).toMatch(/New Order — ORD-1/);
    expect(body.text.body).toMatch(/Cash on Delivery/);
    expect(body.text.body).toMatch(/₹80,752/);
    // More than five lines are summarised.
    expect(body.text.body).toMatch(/…and 2 more/);
  });

  it("the payment line follows paidAt, never the chosen method (S2)", async () => {
    Object.assign(process.env, WA_ENV);
    await wa.sendOrderAlert({ order: { ...order, paymentMethod: "upi", paidAt: null } });
    await wa.sendOrderAlert({ order: { ...order, paymentMethod: "razorpay", paidAt: new Date() } });
    const [unpaid, paid] = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).text.body);
    expect(unpaid).not.toMatch(/Paid online/);
    expect(unpaid).toMatch(/Payment: Cash on Delivery/);
    expect(paid).toMatch(/Payment: Paid online/);
  });

  it("throws on a non-2xx response so callers' .catch sees it", async () => {
    Object.assign(process.env, WA_ENV);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "bad token" });
    await expect(wa.sendOrderAlert({ order, paymentMethod: "cod" })).rejects.toThrow(/401/);
  });

  it("refund, approval and quote alerts carry their key facts", async () => {
    Object.assign(process.env, WA_ENV);
    await wa.sendRefundRequiredAlert({ order, product: "Gold Ring" });
    await wa.sendOrderApprovalAlert({ order });
    await wa.sendOrderApprovalAlert({ order: { ...order, approvalStatus: "REJECTED", rejectionReason: "No stock" } });
    await wa.sendWhatsAppAlert({ customerName: "Asha", customerMobile: "98", productName: "Set", isQuoteOnly: true });
    const texts = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).text.body);
    expect(texts[0]).toMatch(/REFUND NEEDED — ORD-1/);
    expect(texts[0]).toMatch(/Gold Ring/);
    expect(texts[1]).toMatch(/Order Approved/);
    expect(texts[1]).toMatch(/Deliver by: 12 Oct 2026/);
    expect(texts[2]).toMatch(/Order Declined.*\n[\s\S]*Reason: No stock/);
    expect(texts[3]).toMatch(/Quote Required/);
  });
});

describe("email.js (real module, Resend mocked)", () => {
  it("sends through Resend with a plain-text alternative", async () => {
    const email = await vi.importActual("../../server/utils/email.js");
    const r = await email.sendEmail({
      to: "a@b.test",
      subject: "Hi",
      html: "<p>Hello&nbsp;<b>there</b></p><style>x{}</style>",
    });
    expect(r).toEqual({ ok: true, id: "email_test" });
    const sent = globalThis.__mocks.resendSend.mock.calls[0][0];
    expect(sent.to).toEqual(["a@b.test"]);
    expect(sent.text).toBe("Hello there");
    expect(email.isEmailLive()).toBe(true);
  });

  it("reports a provider error without throwing", async () => {
    globalThis.__mocks.resendSend.mockResolvedValueOnce({ data: null, error: { message: "domain not verified" } });
    const email = await vi.importActual("../../server/utils/email.js");
    expect(await email.sendEmail({ to: "a@b.test", subject: "s", html: "<p>x</p>" })).toEqual({
      ok: false,
      error: "domain not verified",
    });
  });

  it("reports a thrown network error without throwing", async () => {
    globalThis.__mocks.resendSend.mockRejectedValueOnce(new Error("ECONNRESET"));
    const email = await vi.importActual("../../server/utils/email.js");
    expect(await email.sendEmail({ to: "a@b.test", subject: "s", html: "<p>x</p>" })).toEqual({
      ok: false,
      error: "ECONNRESET",
    });
  });

  it("refuses to send without to/subject/html", async () => {
    const email = await vi.importActual("../../server/utils/email.js");
    expect((await email.sendEmail({ subject: "s", html: "h" })).ok).toBe(false);
  });

  it("dry-run mode when no API key: logs, reports ok, never calls Resend", async () => {
    vi.resetModules();
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const email = await vi.importActual("../../server/utils/email.js");
      const r = await email.sendEmail({ to: "a@b.test", subject: "s", html: "<p>x</p>" });
      expect(r).toEqual({ ok: true, dryRun: true });
      expect(email.isEmailLive()).toBe(false);
      expect(globalThis.__mocks.resendSend).not.toHaveBeenCalled();
    } finally {
      process.env.RESEND_API_KEY = saved;
      vi.resetModules();
    }
  });

  it("layout helpers render heading, intro and button", async () => {
    const email = await vi.importActual("../../server/utils/email.js");
    const html = email.renderEmailLayout({
      heading: "H1",
      intro: "Intro",
      bodyHtml: email.emailButton("https://x.test/r", "Go"),
      footerNote: "Foot",
    });
    expect(html).toContain("H1");
    expect(html).toContain('href="https://x.test/r"');
    expect(html).toContain("Foot");
  });
});
