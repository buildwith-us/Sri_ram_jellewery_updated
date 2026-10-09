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

  // ── The three modes (Step 2) ──────────────────────────────────────────────
  const withEnv = async (vars, fn) => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("live: sendMail sends plain text through the provider", async () => {
    const email = await vi.importActual("../../server/utils/email.js");
    const r = await email.sendMail({ to: "a@b.test", subject: "Code", text: "Your code is 123456", tag: "sign-in-code" });
    expect(r).toEqual({ ok: true, id: "email_test" });
    const sent = globalThis.__mocks.resendSend.mock.calls[0][0];
    expect(sent).toMatchObject({ to: ["a@b.test"], subject: "Code", text: "Your code is 123456" });
    expect(sent.from).toBe(process.env.EMAIL_FROM);
    expect(email.emailConfig().mode).toBe("live");
  });

  it("live: a provider rejection (e.g. daily quota) is a failure and is logged loudly", async () => {
    globalThis.__mocks.resendSend.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 429, name: "daily_quota_exceeded", message: "You have reached your daily email sending quota" },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const email = await vi.importActual("../../server/utils/email.js");
    const r = await email.sendMail({ to: "a@b.test", subject: "s", text: "t", tag: "sign-in-code" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/daily_quota_exceeded/);
    expect(spy.mock.calls.flat().join(" ")).toMatch(/EMAIL SEND FAILED — sign-in-code .*daily_quota_exceeded/);
  });

  it("console: unconfigured + NODE_ENV=development prints the message and never calls the provider", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await withEnv({ NODE_ENV: "development", RESEND_API_KEY: undefined }, async () => {
      const email = await vi.importActual("../../server/utils/email.js");
      expect(email.emailConfig().mode).toBe("console");
      const r = await email.sendMail({ to: "a@b.test", subject: "s", text: "Your code is 482913" });
      expect(r).toEqual({ ok: true, console: true });
    });
    expect(globalThis.__mocks.resendSend).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toMatch(/482913/);
  });

  it.each(["production", "test", undefined])(
    "unavailable: unconfigured + NODE_ENV=%s fails, prints nothing, never calls the provider",
    async (nodeEnv) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await withEnv({ NODE_ENV: nodeEnv, RESEND_API_KEY: undefined }, async () => {
        const email = await vi.importActual("../../server/utils/email.js");
        expect(email.emailConfig().mode).toBe("unavailable");
        expect(email.canDeliverEmail()).toBe(false);
        const r = await email.sendMail({ to: "a@b.test", subject: "s", text: "Your code is 482913" });
        expect(r).toMatchObject({ ok: false, unavailable: true });
      });
      expect(globalThis.__mocks.resendSend).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join(" ")).not.toMatch(/482913/);
    }
  );

  it("EMAIL_DRY_RUN is honoured only in development", async () => {
    const email = await vi.importActual("../../server/utils/email.js");
    await withEnv({ EMAIL_DRY_RUN: "true", NODE_ENV: "production" }, async () => {
      expect(email.emailConfig().mode).toBe("live");
    });
    await withEnv({ EMAIL_DRY_RUN: "true", NODE_ENV: "development" }, async () => {
      expect(email.emailConfig().mode).toBe("console");
    });
  });

  it.each(["Shop <shop@gmail.com>", "shop@googlemail.com", "Shop <x@outlook.com>"])(
    "a webmail EMAIL_FROM (%s) is not a working configuration",
    async (from) => {
      await withEnv({ EMAIL_FROM: from, NODE_ENV: "production" }, async () => {
        const email = await vi.importActual("../../server/utils/email.js");
        const cfg = email.emailConfig();
        expect(cfg.mode).toBe("unavailable");
        expect(cfg.problems.join(" ")).toMatch(/shop's own domain/);
      });
    }
  );

  it("an unknown EMAIL_PROVIDER is not a working configuration", async () => {
    await withEnv({ EMAIL_PROVIDER: "carrier-pigeon", NODE_ENV: "production" }, async () => {
      const email = await vi.importActual("../../server/utils/email.js");
      expect(email.emailConfig().problems.join(" ")).toMatch(/not supported/);
    });
  });

  it("startup logs FATAL when email is unavailable", async () => {
    vi.resetModules();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withEnv({ NODE_ENV: "production", RESEND_API_KEY: undefined }, async () => {
        await vi.importActual("../../server/utils/email.js");
      });
      expect(spy.mock.calls.flat().join(" ")).toMatch(/FATAL: email is not configured/);
    } finally {
      vi.resetModules();
    }
  });

  it("sendMail requires to, subject and text", async () => {
    const email = await vi.importActual("../../server/utils/email.js");
    expect((await email.sendMail({ to: "a@b.test", subject: "s" })).ok).toBe(false);
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
