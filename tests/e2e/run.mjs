/**
 * End-to-end browser flows (Playwright, headless Chromium).
 *
 *   npm run test:e2e
 *
 * Boots everything it needs and tears it down afterwards:
 *   - MongoMemoryServer (seeded by the app's own first-run seeding)
 *   - the API   (node server/index.js)   on E2E_API_PORT  (default 5402)
 *   - Vite dev  (npx vite --strictPort)  on E2E_WEB_PORT  (default 5476)
 *
 * Hermetic: every browser request to a host other than localhost is aborted
 * (fonts, Unsplash, Razorpay's checkout.js …) and recorded; the one Cloudinary
 * upload is answered locally. The API gets no Razorpay, MSG91, WhatsApp or
 * Resend credentials, so it cannot reach them either.
 *
 * Every flow runs at desktop (1280×800) and mobile (390×844). Console errors
 * are collected per page; failed steps save a screenshot under
 * tests/e2e/artifacts/. A JSON summary is written to
 * tests/e2e/artifacts/results.json. Exit code 1 if any step failed.
 */
import { chromium } from "playwright";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NO_DOTENV = path.join(ROOT, "tests/setup/no-dotenv");
const OUT = path.join(ROOT, "tests/e2e/artifacts");
const API_PORT = Number(process.env.E2E_API_PORT || 5402);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5476);
const WEB = `http://localhost:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}/api`;
const ADMIN_EMAIL = "admin@buildwithus";
const WA_NUMBER = "919000012345";
const WA_GREETING = "Hi, I'd like to know more about your jewellery.";
const ADMIN_PASSWORD = "E2e-Admin-Pass!2026";
const HEADED = Boolean(process.env.E2E_HEADED);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ─── Process management ──────────────────────────────────────────────────────

const children = [];
// Never leave the API or Vite running behind us, however this process ends.
const killChildren = () => {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
};
process.on("exit", killChildren);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
const start = (name, cmd, args, opts) => {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(OUT, `${name}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
  return child;
};

const waitFor = async (url, label, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} did not come up at ${url}`);
};

const cleanup = async (mongod) => {
  for (const c of children) c.kill("SIGTERM");
  await mongod?.stop();
};

// ─── Results ─────────────────────────────────────────────────────────────────

const results = [];
const consoleErrors = [];
const blockedRequests = new Map();

const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80);

/**
 * Run the steps of one flow in order. A failed step screenshots and skips the
 * rest of that flow (later steps depend on it); other flows still run.
 */
const flow = async (viewport, name, page, steps) => {
  let skipped = false;
  for (const [stepName, fn] of steps) {
    const rec = { viewport, flow: name, step: stepName };
    if (skipped) {
      results.push({ ...rec, status: "skipped" });
      continue;
    }
    const t0 = Date.now();
    try {
      const note = await fn();
      results.push({ ...rec, status: "pass", ms: Date.now() - t0, ...(note ? { note } : {}) });
    } catch (err) {
      const shot = path.join(OUT, `${viewport}-${slug(name)}-${slug(stepName)}.png`);
      await page?.screenshot({ path: shot, fullPage: true }).catch(() => {});
      results.push({
        ...rec,
        status: "fail",
        ms: Date.now() - t0,
        error: String(err?.message || err).split("\n").slice(0, 6).join("\n"),
        screenshot: path.relative(ROOT, shot),
        url: page?.url(),
      });
      skipped = true;
    }
  }
};

/** A finding observed in the browser that is a product bug, not a test failure. */
const finding = (viewport, flowName, id, detail) =>
  results.push({ viewport, flow: flowName, step: `FINDING ${id}`, status: "finding", note: detail });

const expectTrue = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ─── API helpers (Node side, not the browser) ────────────────────────────────

// Every 429 the run meets, from the pages and from api(). The API's general
// limit is per IP and the whole run comes from one; a failure that follows
// these is the limiter, not the app.
const rateLimited = [];

// The API's general limit (200 / min / IP, on even in development) is per
// client IP, and the server trusts one proxy hop. Every context in this run
// stands for a different shopper, so each gets its own address, as real
// customers have; one loopback IP doing the work of dozens of shoppers in a
// few minutes used to trip the limit mid-run and sign customers out.
let ipSeq = 0;
const nextClientIp = () => {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
};
let runnerIp = nextClientIp();
let runnerCalls = 0;
const noteRateLimit = (where, url) => {
  if (rateLimited.length < 200) rateLimited.push({ where, path: new URL(url).pathname, at: new Date().toISOString().slice(11, 19) });
};

const api = async (method, p, { token, body } = {}) => {
  // The runner's own calls rotate address every 100, for the same reason.
  if (++runnerCalls % 100 === 0) runnerIp = nextClientIp();
  const r = await fetch(`${API}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": runnerIp,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429) noteRateLimit("test", `${API}${p}`);
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, body: json };
};

let mongoUri = null;
/** An account as it exists in old data — the site can no longer create one without a phone. */
const insertUser = async (doc) => {
  const client = await MongoClient.connect(mongoUri);
  try {
    await client.db("e2e").collection("users").insertOne({ ...doc, createdAt: new Date(), updatedAt: new Date() });
  } finally {
    await client.close();
  }
};
let adminTokenCache = null;
const adminToken = async () => {
  if (adminTokenCache) return adminTokenCache;
  const r = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  adminTokenCache = (await r.json()).accessToken;
  return adminTokenCache;
};

const tokenOf = (page) => page.evaluate(() => localStorage.getItem("sri-ram-access-token"));

let phoneSeq = 0;
const freshPhone = () => `9${String(Date.now() % 1e8).padStart(8, "0")}${++phoneSeq % 10}`;

const rupees = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
/** Matches a price however the page spaces it ("₹1,04,545" or "₹ 1,04,545"). */
const priceText = (n) => new RegExp(`₹\\s?${Math.round(n).toLocaleString("en-IN")}`);
const parseRupees = (s) => Number(String(s).replace(/[^\d.]/g, ""));

// ─── Browser setup ───────────────────────────────────────────────────────────

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

const DISMISSED_UNTIL_KEY = "sri-ram-auth-prompt-dismissed-until";

/**
 * `timer: false` (the default) pre-dismisses the timed sign-in prompt so it
 * cannot pop up in the middle of flows that are testing something else. The
 * flow that tests the prompt itself opens its context with `timer: true`.
 */
const newContext = async (browser, viewport, { timer = false } = {}) => {
  const size = viewport === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const context = await browser.newContext({
    viewport: size,
    isMobile: viewport === "mobile",
    hasTouch: viewport === "mobile",
    deviceScaleFactor: 1,
    extraHTTPHeaders: { "X-Forwarded-For": nextClientIp() },
  });
  if (!timer) {
    await context.addInitScript((key) => {
      try {
        localStorage.setItem(key, String(Date.now() + 365 * 24 * 3600 * 1000));
      } catch {}
    }, DISMISSED_UNTIL_KEY);
  }

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const local = ["localhost", "127.0.0.1"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol);
    if (local) return route.continue();
    if (url.hostname === "api.cloudinary.com" && url.pathname.endsWith("/image/upload")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ secure_url: `${WEB}/logo.png`, public_id: "e2e" }),
      });
    }
    blockedRequests.set(url.hostname, (blockedRequests.get(url.hostname) || 0) + 1);
    return route.abort("blockedbyclient");
  });

  context.on("page", (p) => attachConsole(p, viewport));
  return context;
};

const attachConsole = (page, viewport) => {
  page.on("response", (res) => {
    if (res.status() === 429) noteRateLimit(viewport, res.url());
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Aborted third-party requests are our doing, not the app's.
    if (/ERR_BLOCKED_BY_CLIENT|ERR_FAILED/.test(text)) return;
    consoleErrors.push({ viewport, url: new URL(page.url()).pathname, kind: "console", text: text.slice(0, 400) });
  });
  page.on("pageerror", (err) => {
    consoleErrors.push({ viewport, url: new URL(page.url()).pathname, kind: "pageerror", text: String(err.message).slice(0, 400) });
  });
};

/** Safety net: close a sign-in dialog that is open but not part of the step. */
const dismissNudge = async (page) => {
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible().catch(() => false)) await page.keyboard.press("Escape");
};

const overflow = new Map(); // "viewport path" → description of what sticks out

/** At phone width, record any page that scrolls sideways and what causes it. */
const checkOverflow = async (page) => {
  const vp = page.viewportSize();
  if (!vp || vp.width > 500) return;
  const pathname = new URL(page.url()).pathname.replace(/[0-9a-f]{24}/, ":id");
  if (overflow.has(pathname)) return;
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const doc = document.documentElement;
    const over = doc.scrollWidth - window.innerWidth;
    if (over <= 1) return null;
    const culprits = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1 && r.width > 0 && getComputedStyle(el).position !== "fixed") {
        const parentOver = el.parentElement && el.parentElement.getBoundingClientRect().right > window.innerWidth + 1;
        if (!parentOver) {
          const cls = (el.className && typeof el.className === "string" ? el.className : "").split(/\s+/).slice(0, 4).join(".");
          culprits.push(`<${el.tagName.toLowerCase()}${cls ? "." + cls : ""}> right=${Math.round(r.right)}px "${(el.innerText || "").trim().slice(0, 40).replace(/\s+/g, " ")}"`);
        }
      }
      if (culprits.length >= 3) break;
    }
    return { scrollWidth: doc.scrollWidth, viewport: window.innerWidth, culprits };
  });
  overflow.set(pathname, info);
};

const goto = async (page, p) => {
  await page.goto(`${WEB}${p}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await checkOverflow(page).catch(() => {});
};

// ─── Flows ───────────────────────────────────────────────────────────────────

let emailSeq = 0;
const freshEmail = (tag) => `e2e.${tag}.${Date.now()}.${++emailSeq}@example.com`;

/**
 * The code the API "sent" to `email`. The E2E API runs in development with no
 * email provider, i.e. the console mode: each message is printed to its log.
 */
const codeFor = async (email) => {
  const esc = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`To:\\s+${esc}\\nSubject:[^\\n]*\\n\\n[^\\n]*sign-in code is (\\d{6})`, "g");
  for (let i = 0; i < 40; i++) {
    const log = fs.readFileSync(path.join(OUT, "api.log"), "utf8");
    const matches = [...log.matchAll(re)];
    if (matches.length) return matches.at(-1)[1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no sign-in code for ${email} in api.log`);
};

/**
 * Sign in with the email flow, in the modal (prefix "auth-modal") or on the
 * /login page (prefix "auth-page"). A new account also gets name + phone.
 * Returns whether the details step was shown.
 */
const signInWithEmail = async (page, email, { prefix = "auth-modal", name = "E2E Customer", phone = freshPhone() } = {}) => {
  await page.locator(`#${prefix}-email`).fill(email);
  await page.getByRole("button", { name: /^send code$/i }).click();
  await page.locator(`#${prefix}-code`).waitFor({ timeout: 10_000 });
  await page.locator(`#${prefix}-code`).fill(await codeFor(email));
  await page.getByRole("button", { name: /verify & continue/i }).click();
  const nameInput = page.locator(`#${prefix}-name`);
  const details = await nameInput.waitFor({ timeout: 6_000 }).then(() => true, () => false);
  if (details) {
    await nameInput.fill(name);
    await page.locator(`#${prefix}-phone`).fill(phone);
    await page.getByRole("button", { name: /^(continue|create account)$/i }).click();
  }
  return details;
};

const focusIsInsideDialog = (page) =>
  page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));

const addAddressViaUi = async (page) => {
  await goto(page, "/dashboard/myAddress");
  await page.getByRole("button", { name: /add new address/i }).click();
  await page.locator('[name="firstName"]').fill("Asha");
  await page.locator('[name="lastName"]').fill("Raman");
  await page.locator('[name="email"]').fill("asha@example.test");
  await page.locator('[name="streetAddress"]').fill("12 Temple Street");
  const city = page.locator('select[name="city"]');
  await city.selectOption({ label: "Madurai" }).catch(async () => {
    const values = await city.locator("option:not([disabled])").evaluateAll((os) => os.map((o) => o.value));
    await city.selectOption(values[0]);
  });
  await page.locator('[name="postalCode"]').fill("625001");
  await page.locator('[name="mobileNumber"]').fill("9876543210");
  await page.getByRole("button", { name: /save address/i }).click();
  await page.getByText(/12 Temple Street/i).first().waitFor({ timeout: 10_000 });
};

/**
 * Fake Razorpay for one page: serve a stand-in checkout.js and answer
 * create-order / verify locally. window.__fakeRazorpayMode = "pay" | "dismiss".
 * Also counts POST /api/orders and /api/payment/verify on the page.
 */
const installFakeRazorpay = async (page) => {
  page.__ordersPosted = 0;
  page.__verifyCalls = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/orders$/.test(new URL(r.url()).pathname)) page.__ordersPosted += 1;
  });
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.Razorpay = function (options) {
        this.on = function () {};
        this.open = function () {
          setTimeout(function () {
            if (window.__fakeRazorpayMode === "pay") {
              options.handler({ razorpay_order_id: options.order_id, razorpay_payment_id: "pay_e2e", razorpay_signature: "sig_e2e" });
            } else if (options.modal && options.modal.ondismiss) {
              options.modal.ondismiss();
            }
          }, 100);
        };
      };`,
    })
  );
  await page.route("**/api/payment/create-order", async (route) => {
    const body = route.request().postDataJSON();
    const amount = (body.items || []).reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ success: true, razorpayOrderId: "order_e2e", amount, currency: "INR", orderId: "0123456789abcdef01234567", key: "rzp_test_e2e" }),
    });
  });
  await page.route("**/api/payment/verify", async (route) => {
    page.__verifyCalls += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true, message: "Payment verified successfully" }) });
  });
};

const runCustomerFlows = async (browser, viewport, seeded, shared) => {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const p1 = seeded.p1;
  const p4 = seeded.p4;
  const phone = freshPhone();
  let token;

  await flow(viewport, "Guest browsing", page, [
    ["Home renders", async () => {
      await goto(page, "/");
      await page.locator("main, #root > *").first().waitFor();
      expectTrue((await page.locator("body").innerText()).length > 200, "home page looks empty");
    }],
    ["Shop lists products", async () => {
      await goto(page, "/shop");
      await dismissNudge(page);
      await page.locator("article").first().waitFor({ timeout: 15_000 });
      const n = await page.locator("article").count();
      expectTrue(n >= 5, `expected ≥5 product cards, got ${n}`);
      return `${n} cards`;
    }],
    ["Shop metal filter: Silver", async () => {
      await page.getByRole("button", { name: /^metal/i }).click();
      await page.getByRole("button", { name: /^silver$/i }).click();
      await page.waitForURL(/metal=silver/);
      let names = [];
      for (let i = 0; i < 20; i++) {
        names = await page.locator("article h3").allInnerTexts();
        if (names.length && !names.some((n) => /gold|diamond/i.test(n))) break;
        await page.waitForTimeout(250);
      }
      expectTrue(names.length >= 1, "no silver products shown");
      expectTrue(!names.some((n) => /gold|diamond/i.test(n)), `non-silver product under silver filter: ${names.join(", ")}`);
      return names.join(", ");
    }],
    ["Shop price filter: Over ₹1L", async () => {
      await goto(page, "/shop");
      await dismissNudge(page);
      await page.getByRole("button", { name: /^price/i }).click();
      const option = page.getByRole("button", { name: /over ₹1l/i });
      // M1 fixed: every option of the menu is on screen, so it can be tapped.
      const width = page.viewportSize().width;
      for (const b of await page.getByRole("button", { name: /^(all|under ₹50k|₹50k - ₹1l|over ₹1l|price on request)$/i }).all()) {
        const box = await b.boundingBox();
        if (!box) continue;
        expectTrue(box.x >= 0 && box.x + box.width <= width, `Price option "${await b.innerText()}" is off-screen at ${width}px (${Math.round(box.x)}–${Math.round(box.x + box.width)}px)`);
      }
      await option.click();
      await page.waitForURL(/price=over1l/);
      let names = [];
      for (let i = 0; i < 20; i++) {
        names = await page.locator("article h3").allInnerTexts();
        if (names.includes(p1.name) && names.length < 5) break;
        await page.waitForTimeout(250);
      }
      expectTrue(names.includes(p1.name), `${p1.name} (${rupees(p1.price)}) missing from Over ₹1L: ${names.join(", ")}`);
      return names.join(", ");
    }],
    ["Open product page from card; server price shown", async () => {
      await goto(page, "/shop");
      await dismissNudge(page);
      await page.locator("article", { hasText: p1.name }).first().click();
      await page.waitForURL(new RegExp(`/products/${p1._id}/description`));
      await page.getByText(priceText(p1.price)).first().waitFor({ timeout: 10_000 });
      return `${p1.name} shows ${rupees(p1.price)}`;
    }],
    ["Description and Client Reviews tabs", async () => {
      await page.getByRole("link", { name: /client reviews/i }).click();
      await page.waitForURL(/\/reviews$/);
      await page.getByRole("link", { name: /^description$/i }).click();
      await page.waitForURL(/\/description$/);
    }],
    ["Image zoom modal opens and closes", async () => {
      await dismissNudge(page);
      await page.locator("img").filter({ hasNot: page.locator("header img") }).first();
      await page.evaluate(() => document.getElementById("imageModal")?.showModal());
      await page.locator("dialog#imageModal[open]").waitFor({ timeout: 5_000 });
      const zoomBtn = page.locator("dialog#imageModal button").filter({ hasNotText: /close/i }).last();
      await zoomBtn.click().catch(() => {});
      await page.keyboard.press("Escape");
      await page.locator("dialog#imageModal[open]").waitFor({ state: "detached", timeout: 5_000 }).catch(async () => {
        expectTrue(!(await page.locator("dialog#imageModal[open]").isVisible()), "zoom modal did not close");
      });
    }],
  ]);

  await flow(viewport, "Add to bag → sign-in modal → resume", page, [
    ["Guest ADD TO BAG opens the sign-in modal, focus inside", async () => {
      await goto(page, `/products/${p1._id}/description`);
      await page.getByRole("button", { name: /add to bag/i }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 5_000 });
      await dialog.getByText(/sign in to add this piece to your bag/i).waitFor();
      expectTrue(await focusIsInsideDialog(page), "focus did not move into the dialog");
      expectTrue(
        (await page.evaluate(() => getComputedStyle(document.body).overflow)) === "hidden",
        "background scroll is not locked"
      );
    }],
    ["New email: code, then name + phone, in the modal", async () => {
      const shownDetails = await signInWithEmail(page, freshEmail(viewport), { phone });
      expectTrue(shownDetails, "a new account was not asked for name and phone");
      await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 });
      token = await tokenOf(page);
      expectTrue(token, "no access token in localStorage after sign-in");
      const me = (await api("GET", "/users/me", { token })).body.data;
      expectTrue(me.name === "E2E Customer" && me.phone === `+91${phone}`, `profile not saved: ${JSON.stringify(me)}`);
    }],
    ["Back on the same product page — no /welcome detour with an action pending", async () => {
      expectTrue(new URL(page.url()).pathname === `/products/${p1._id}/description`, `ended on ${page.url()}`);
    }],
    ["Pending ADD TO BAG resumes after sign-in", async () => {
      let cart = [];
      for (let i = 0; i < 20 && !cart.length; i++) {
        cart = (await api("GET", "/cart", { token })).body;
        if (!cart.length) await page.waitForTimeout(500);
      }
      expectTrue(Array.isArray(cart) && cart.some((c) => c.productId === p1.productId), `cart after resume: ${JSON.stringify(cart)}`);
      return `landed on ${new URL(page.url()).pathname}`;
    }],
  ]);

  await flow(viewport, "Address + COD checkout", page, [
    ["Add shipping address in Address Book", async () => addAddressViaUi(page)],
    ["Checkout lists the bag with the server price", async () => {
      await goto(page, "/checkout");
      await page.getByText(p1.name).first().waitFor({ timeout: 10_000 });
      await page.getByText(priceText(p1.price)).first().waitFor();
    }],
    ["Cash on Delivery → Complete Order → /order-success", async () => {
      await page.getByText("CASH ON DELIVERY", { exact: true }).click();
      await page.getByRole("button", { name: /complete order/i }).click();
      await page.waitForURL(/\/order-success/, { timeout: 15_000 });
      await page.getByText(/order confirmed/i).waitFor({ timeout: 10_000 });
    }],
    ["Order stored at the server price; bag cleared", async () => {
      const orders = (await api("GET", "/orders", { token })).body;
      expectTrue(orders.length === 1, `expected 1 order, got ${orders.length}`);
      expectTrue(orders[0].totalAmount === p1.price, `order total ${orders[0].totalAmount} ≠ product price ${p1.price}`);
      expectTrue(orders[0].paymentMethod === "cod", `paymentMethod ${orders[0].paymentMethod}`);
      const cart = (await api("GET", "/cart", { token })).body;
      expectTrue(cart.length === 0, `cart not cleared: ${cart.length} items`);
      shared[viewport] = { orderId: orders[0]._id, token, page };
    }],
    ["My Orders shows the order awaiting confirmation", async () => {
      await goto(page, "/dashboard/myOrders");
      await page.getByText(/awaiting confirmation/i).first().waitFor({ timeout: 10_000 });
    }],
  ]);

  await flow(viewport, "Buy Now keeps the bag", page, [
    ["Put another piece in the bag", async () => {
      await goto(page, `/products/${p4._id}/description`);
      await page.getByRole("button", { name: /add to bag/i }).click();
      let cart = [];
      for (let i = 0; i < 20 && !cart.length; i++) {
        cart = (await api("GET", "/cart", { token })).body;
        if (!cart.length) await page.waitForTimeout(300);
      }
      expectTrue(cart.length === 1, `bag has ${cart.length} items`);
    }],
    ["BUY NOW a different piece, pay COD", async () => {
      await goto(page, `/products/${p1._id}/description`);
      await page.getByRole("button", { name: /buy now/i }).click();
      await page.waitForURL(/\/checkout/);
      await page.getByText(p1.name).first().waitFor();
      await page.getByText("CASH ON DELIVERY", { exact: true }).click();
      await page.getByRole("button", { name: /complete order/i }).click();
      await page.waitForURL(/\/order-success/, { timeout: 15_000 });
    }],
    ["Bag still holds the other piece", async () => {
      const cart = (await api("GET", "/cart", { token })).body;
      expectTrue(cart.length === 1 && cart[0].productId === p4.productId, `bag after Buy Now: ${JSON.stringify(cart.map((c) => c.productId))}`);
    }],
  ]);

  await flow(viewport, "Wishlist add / remove", page, [
    ["Heart on a Shop card adds to wishlist", async () => {
      await goto(page, "/shop");
      const card = page.locator("article", { hasText: p4.name }).first();
      await card.hover().catch(() => {});
      await card.locator("button").first().click({ force: true });
      let wl = [];
      for (let i = 0; i < 20 && !wl.length; i++) {
        wl = (await api("GET", "/wishlist", { token })).body;
        if (!wl.length) await page.waitForTimeout(300);
      }
      expectTrue(wl.length === 1, `wishlist has ${wl.length}`);
    }],
    ["Card heart shows as filled (in wishlist)", async () => {
      await page.waitForTimeout(800);
      const card = page.locator("article", { hasText: p4.name }).first();
      const fill = await card.locator("button span").first().evaluate((el) => el.style.fontVariationSettings);
      // F1 fixed: the saved line's productId now matches the card's product.
      expectTrue(/["']FILL["'] 1/.test(fill), `card heart stays unfilled after adding (fontVariationSettings=${fill})`);
    }],
    ["Clicking the heart again removes it", async () => {
      const card = page.locator("article", { hasText: p4.name }).first();
      await card.hover().catch(() => {});
      await card.locator("button").first().click({ force: true });
      await page.waitForTimeout(1200);
      const wl = (await api("GET", "/wishlist", { token })).body;
      expectTrue(wl.length === 0, `second heart click did not remove the item (wishlist still has ${wl.length})`);
    }],
    ["Remove from the Wishlist page", async () => {
      await api("POST", "/wishlist", { token, body: { productId: p4.productId, name: p4.name } });
      await goto(page, "/wishlist");
      await page.getByText(p4.name).first().waitFor({ timeout: 10_000 });
      await page.locator("main button").filter({ has: page.locator("span.material-symbols-outlined") }).first().click();
      await page.getByRole("button", { name: /yes, remove it/i }).click();
      await page.waitForTimeout(800);
      const wl = (await api("GET", "/wishlist", { token })).body;
      expectTrue(wl.length === 0, `wishlist still has ${wl.length} after removing on /wishlist`);
    }],
  ]);

  // Decision 1: the UPI tile uses the existing Razorpay flow. Real Razorpay
  // cannot run here, so its script and the two payment calls are faked in
  // the browser; the server side of that path is covered by the API tests.
  await flow(viewport, "UPI / QR SCAN pays through Razorpay (Decision 1)", page, [
    ["UPI tile shows the Razorpay box; Complete Order waits for payment", async () => {
      await installFakeRazorpay(page);
      await goto(page, `/products/${p4._id}/description`);
      // The bag still holds p4 from the Buy Now flow; make sure of it.
      const cart = (await api("GET", "/cart", { token })).body;
      if (!cart.some((c) => c.productId === p4.productId)) {
        await page.getByRole("button", { name: /add to bag/i }).click();
        await page.waitForTimeout(800);
      }
      await goto(page, "/checkout");
      await page.getByText("UPI / QR SCAN", { exact: true }).click();
      await page.getByRole("button", { name: /with razorpay/i }).waitFor({ timeout: 10_000 });
      expectTrue(await page.getByRole("button", { name: /complete order/i }).isDisabled(), "Complete Order enabled before payment");
    }],
    ["Abandoned payment: nothing placed, bag kept", async () => {
      await page.evaluate(() => (window.__fakeRazorpayMode = "dismiss"));
      await page.getByRole("button", { name: /with razorpay/i }).click();
      await page.waitForTimeout(800);
      expectTrue(await page.getByRole("button", { name: /complete order/i }).isDisabled(), "Complete Order enabled after an abandoned payment");
      expectTrue(page.__ordersPosted === 0, `POST /api/orders was called ${page.__ordersPosted} time(s)`);
      const cart = (await api("GET", "/cart", { token })).body;
      expectTrue(cart.some((c) => c.productId === p4.productId), "the bag lost its item");
    }],
    ["Completed payment: Complete Order → /order-success, never POST /api/orders", async () => {
      await page.evaluate(() => (window.__fakeRazorpayMode = "pay"));
      await page.getByRole("button", { name: /with razorpay/i }).click();
      await page.getByText(/payment authorized/i).waitFor({ timeout: 10_000 });
      // B20: after paying, switching to Cash on Delivery must not be possible —
      // it used to place a second (COD) order for the same items.
      // The tile is aria-disabled now, which Playwright refuses to click; a
      // customer can still tap it, so force the click to do exactly that.
      await page.getByText("CASH ON DELIVERY", { exact: true }).click({ force: true });
      await page.getByText(/payment received — your order is placed/i).waitFor({ timeout: 5_000 });
      const codChecked = await page.locator('input[name="payment"]').nth(2).isChecked();
      expectTrue(!codChecked, "Cash on Delivery could still be selected after paying");
      const complete = page.getByRole("button", { name: /complete order/i });
      expectTrue(await complete.isEnabled(), "Complete Order still disabled after payment");
      await complete.click();
      await page.waitForURL(/\/order-success/, { timeout: 15_000 });
      expectTrue(page.__ordersPosted === 0, `POST /api/orders was called ${page.__ordersPosted} time(s)`);
      expectTrue(page.__verifyCalls === 1, `/payment/verify called ${page.__verifyCalls} time(s)`);
    }],
  ]);

  await flow(viewport, "Customer blocked from admin", page, [
    ["/dashboard/adminDashboard → /403", async () => {
      await goto(page, "/dashboard/adminDashboard");
      await page.waitForURL(/\/403/, { timeout: 10_000 });
    }],
  ]);

  return context;
};

const runTimedPromptFlow = async (browser, viewport, seeded) => {
  const context = await newContext(browser, viewport, { timer: true });
  const page = await context.newPage();
  const p4 = seeded.p4;
  let t0 = 0;
  const dialog = () => page.getByRole("dialog");

  await flow(viewport, "Timed sign-in prompt", page, [
    ["Not shown in the first 20 s", async () => {
      t0 = Date.now();
      await goto(page, "/");
      await page.waitForTimeout(20_000);
      expectTrue(!(await dialog().isVisible()), "the prompt appeared before 30 s of active time");
    }],
    ["Appears once 30 s of active time have passed, focus inside", async () => {
      await dialog().waitFor({ timeout: 20_000 });
      const waited = Date.now() - t0;
      expectTrue(waited >= 29_000, `appeared after only ${waited} ms`);
      expectTrue(await focusIsInsideDialog(page), "focus did not move into the dialog");
      return `appeared after ${(waited / 1000).toFixed(1)} s`;
    }],
    ["Esc closes it; the dismissal is remembered for 7 days", async () => {
      await page.keyboard.press("Escape");
      await dialog().waitFor({ state: "detached", timeout: 5_000 });
      const until = Number(await page.evaluate((k) => localStorage.getItem(k), DISMISSED_UNTIL_KEY));
      const days = (until - Date.now()) / 86_400_000;
      expectTrue(days > 6.9 && days <= 7.01, `dismissal lasts ${days.toFixed(2)} days`);
    }],
    ["A new tab (fresh session) does not show it again", async () => {
      const tab = await context.newPage();
      await goto(tab, "/");
      await tab.waitForTimeout(35_000);
      const shown = await tab.getByRole("dialog").isVisible();
      await tab.close();
      expectTrue(!shown, "the prompt reappeared within the 7-day dismissal");
    }],
    ["Intents still open it after dismissal; Esc returns focus to the trigger", async () => {
      await goto(page, `/products/${p4._id}/description`);
      await page.getByRole("button", { name: /add to bag/i }).click();
      await dialog().waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");
      await dialog().waitFor({ state: "detached", timeout: 5_000 });
      const focused = await page.evaluate(() => document.activeElement?.textContent || "");
      expectTrue(/add to bag/i.test(focused), `focus went to "${focused.trim().slice(0, 40)}"`);
    }],
    ["Tab and Shift+Tab stay inside the modal", async () => {
      await page.getByRole("button", { name: /add to bag/i }).click();
      await dialog().waitFor({ timeout: 5_000 });
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
        expectTrue(await focusIsInsideDialog(page), `focus escaped the dialog after ${i + 1} tab presses`);
      }
    }],
    ["Sign in as a new email: back on the same page, bag intact", async () => {
      const shownDetails = await signInWithEmail(page, freshEmail(`timer-${viewport}`));
      expectTrue(shownDetails, "new account was not asked for name and phone");
      await dialog().waitFor({ state: "detached", timeout: 10_000 });
      expectTrue(new URL(page.url()).pathname === `/products/${p4._id}/description`, `ended on ${page.url()}`);
      const token = await tokenOf(page);
      let cart = [];
      for (let i = 0; i < 20 && !cart.length; i++) {
        cart = (await api("GET", "/cart", { token })).body;
        if (!cart.length) await page.waitForTimeout(300);
      }
      expectTrue(cart.length === 1 && cart[0].productId === p4.productId, `bag after sign-in: ${JSON.stringify(cart.map((c) => c.productId))}`);
    }],
  ]);
  return context;
};

/**
 * Registration: name + phone → email → code, and nothing is saved before the
 * code. Sign in for an address with no account asks for name + phone after
 * the code. An EXISTING account with gaps (made before both were required) is
 * asked again on any page, and closing that step signs out.
 */
const runRegistrationFlow = async (browser, viewport, seeded) => {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const p4 = seeded.p4;
  const dialog = () => page.getByRole("dialog");
  const modalEmail = freshEmail(`reg-modal-${viewport}`);
  const registerEmail = freshEmail(`reg-page-${viewport}`);
  const clashEmail = freshEmail(`reg-clash-${viewport}`);
  const legacyEmail = freshEmail(`reg-legacy-${viewport}`);
  let registeredPhone;

  const enterCode = async (prefix, email) => {
    await page.locator(`#${prefix}-email`).fill(email);
    await page.getByRole("button", { name: /^send code$/i }).click();
    await page.locator(`#${prefix}-code`).waitFor({ timeout: 10_000 });
    await page.locator(`#${prefix}-code`).fill(await codeFor(email));
    await page.getByRole("button", { name: /verify & continue/i }).click();
  };
  const waitForToken = async (want) => {
    for (let i = 0; i < 30; i++) {
      if (Boolean(await tokenOf(page)) === want) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };
  const accountFor = async (email) => {
    const users = (await api("GET", "/users", { token: await adminToken() })).body;
    return users.find((u) => u.email === email || u.emailKey === email) || null;
  };
  const signOut = () => page.evaluate(() => localStorage.clear());

  await flow(viewport, "Registration", page, [
    ["Modal, unknown email: closing at name + phone leaves no account and no session", async () => {
      await goto(page, `/products/${p4._id}/description`);
      await dismissNudge(page);
      await page.getByRole("button", { name: /add to bag/i }).click();
      await dialog().waitFor({ timeout: 5_000 });
      await enterCode("auth-modal", modalEmail);
      await page.locator("#auth-modal-name").waitFor({ timeout: 10_000 });
      await page.getByText(/no account for .* yet/i).waitFor({ timeout: 3_000 });
      expectTrue(!(await tokenOf(page)), "signed in before the account exists");
      await page.keyboard.press("Escape");
      await dialog().waitFor({ state: "detached", timeout: 5_000 });
      expectTrue(!(await tokenOf(page)), "signed in after closing");
      expectTrue(!(await accountFor(modalEmail)), "an account was created without name and phone");
    }],
    ["Modal: name + phone after the code creates the account; the bag action resumes", async () => {
      await page.getByRole("button", { name: /add to bag/i }).click();
      await dialog().waitFor({ timeout: 5_000 });
      const asked = await signInWithEmail(page, modalEmail);
      expectTrue(asked, "name and phone were not asked for");
      await dialog().waitFor({ state: "detached", timeout: 10_000 });
      const token = await tokenOf(page);
      let cart = [];
      for (let i = 0; i < 20 && !cart.length; i++) {
        cart = (await api("GET", "/cart", { token })).body;
        if (!cart.length) await page.waitForTimeout(300);
      }
      expectTrue(Array.isArray(cart) && cart.length === 1 && cart[0].productId === p4.productId, `bag: ${JSON.stringify(cart)}`);
      const me = (await api("GET", "/users/me", { token })).body.data;
      expectTrue(me.profileComplete === true, `profile: ${JSON.stringify(me)}`);
      await signOut();
    }],
    ["/register: name + phone first, then email and code; nothing saved before the code", async () => {
      await goto(page, "/register");
      await page.getByText(/next, we'll confirm your email/i).waitFor({ timeout: 5_000 });
      await page.locator("#auth-page-name").fill("Register Path");
      // A bad number is caught here, before any email is sent.
      await page.locator("#auth-page-phone").fill("12345");
      await page.getByRole("button", { name: /^continue$/i }).click();
      await page.getByRole("alert").waitFor({ timeout: 3_000 });
      expectTrue(await page.locator("#auth-page-email").count() === 0, "moved on with an invalid number");
      registeredPhone = freshPhone();
      await page.locator("#auth-page-phone").fill(registeredPhone);
      await page.getByRole("button", { name: /^continue$/i }).click();
      await page.locator("#auth-page-email").fill(registerEmail);
      await page.getByRole("button", { name: /^send code$/i }).click();
      await page.locator("#auth-page-code").waitFor({ timeout: 10_000 });
      expectTrue(!(await accountFor(registerEmail)), "an account exists before the code was entered");
      await page.locator("#auth-page-code").fill(await codeFor(registerEmail));
      await page.getByRole("button", { name: /verify & continue/i }).click();
      await page.waitForURL(/\/welcome/, { timeout: 10_000 });
      const me = (await api("GET", "/users/me", { token: await tokenOf(page) })).body.data;
      expectTrue(me.name === "Register Path" && me.phone === `+91${registeredPhone}` && me.profileComplete, `profile: ${JSON.stringify({ name: me.name, phone: me.phone })}`);
      await signOut();
    }],
    ["A taken phone is only reported after the code; changing it creates the account", async () => {
      await goto(page, "/register");
      await page.locator("#auth-page-name").fill("Clash Path");
      await page.locator("#auth-page-phone").fill(registeredPhone);
      await page.getByRole("button", { name: /^continue$/i }).click();
      // No lookup before the code: the email step comes up as for any number.
      await page.locator("#auth-page-email").waitFor({ timeout: 5_000 });
      await enterCode("auth-page", clashEmail);
      await page.getByText(/already linked to another account/i).waitFor({ timeout: 10_000 });
      expectTrue(await page.locator("#auth-page-phone").inputValue() !== "", "the typed number was cleared");
      expectTrue(!(await tokenOf(page)) && !(await accountFor(clashEmail)), "an account or session exists after the clash");
      await page.locator("#auth-page-phone").fill(freshPhone());
      await page.getByRole("button", { name: /^continue$/i }).click();
      await page.waitForURL(/\/welcome/, { timeout: 10_000 });
      expectTrue(Boolean(await accountFor(clashEmail)), "no account after fixing the number");
      await signOut();
    }],
    ["An existing account with no phone: asked after the code; closing signs out", async () => {
      await insertUser({ emailKey: legacyEmail, email: legacyEmail, role: "USER", name: "Half Done" });
      await goto(page, "/login");
      await enterCode("auth-page", legacyEmail);
      await page.locator("#auth-page-name").waitFor({ timeout: 10_000 });
      expectTrue(await page.locator("#auth-page-name").inputValue() === "Half Done", "name not prefilled");
      expectTrue(await waitForToken(true), "an existing account is not signed in at its details step");
      // Walking off the page: the next page asks again.
      await goto(page, "/shop");
      await page.locator("#auth-modal-name").waitFor({ timeout: 10_000 });
      await page.getByText(/closing this signs you out/i).waitFor({ timeout: 3_000 });
      expectTrue(await page.getByRole("button", { name: /close and sign out/i }).count() === 1, "the close button doesn't say it signs out");
      await page.keyboard.press("Escape");
      await dialog().waitFor({ state: "detached", timeout: 5_000 });
      expectTrue(await waitForToken(false), "still signed in after closing");
      await page.getByText(/we need your name and mobile number/i).first().waitFor({ timeout: 5_000 });
    }],
    ["…and on a reload it asks again, refuses a bad number, then saves once", async () => {
      await goto(page, "/login");
      await enterCode("auth-page", legacyEmail);
      await page.locator("#auth-page-name").waitFor({ timeout: 10_000 });
      await page.reload();
      await page.locator("#auth-modal-name").waitFor({ timeout: 10_000 }).catch(async () => {
        // /login itself shows a fresh sign-in on reload; any other page asks.
        await goto(page, "/");
        await page.locator("#auth-modal-name").waitFor({ timeout: 10_000 });
      });
      await page.locator("#auth-modal-phone").fill("12345");
      await page.getByRole("button", { name: /^continue$/i }).click();
      await dialog().getByRole("alert").waitFor({ timeout: 5_000 });
      const phone = freshPhone();
      await page.locator("#auth-modal-phone").fill(phone);
      await page.getByRole("button", { name: /^continue$/i }).click();
      await dialog().waitFor({ state: "detached", timeout: 10_000 });
      const me = (await api("GET", "/users/me", { token: await tokenOf(page) })).body.data;
      expectTrue(me.profileComplete === true && me.phone === `+91${phone}` && me.name === "Half Done", `profile: ${JSON.stringify({ name: me.name, phone: me.phone })}`);
      await page.reload();
      await page.waitForTimeout(3_000);
      expectTrue(!(await dialog().isVisible()), "asked again after the profile was complete");
    }],
  ]);
  return context;
};

/**
 * The floating WhatsApp chat link: on customer pages, labelled, keyboard
 * reachable, inside the screen, and out of the way of every overlay.
 */
const runWhatsAppChatFlow = async (browser, viewport, seeded) => {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const chat = () => page.locator('[data-testid="whatsapp-chat"]');
  const hidden = async (what) => {
    for (let i = 0; i < 20; i++) {
      if ((await chat().count()) === 0) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`the WhatsApp button stayed on screen over ${what}`);
  };
  const shown = async (what) => {
    await chat().waitFor({ timeout: 5_000 }).catch(() => {
      throw new Error(`the WhatsApp button did not come back after ${what}`);
    });
  };
  const insideViewport = async () => {
    const box = await chat().boundingBox();
    const vp = page.viewportSize();
    expectTrue(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height, `button outside the screen: ${JSON.stringify(box)}`);
    expectTrue(box.height >= 44, `button is ${box.height}px tall`);
    return box;
  };

  await flow(viewport, "WhatsApp chat link", page, [
    ["Shown with a text label; opens the shop's chat with the greeting", async () => {
      await goto(page, "/");
      await chat().waitFor({ timeout: 10_000 });
      const href = await chat().getAttribute("href");
      expectTrue(href === `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(WA_GREETING)}`, `href ${href}`);
      expectTrue((await chat().getAttribute("target")) === "_blank", "does not open in a new tab");
      const text = (await chat().innerText()).trim();
      expectTrue(/whatsapp/i.test(text), `visible text "${text}"`);
      expectTrue(/whatsapp/i.test((await chat().getAttribute("aria-label")) || ""), "no accessible name");
      await insideViewport();
    }],
    ["Keyboard reachable with Tab", async () => {
      await goto(page, "/shop");
      await chat().waitFor({ timeout: 10_000 });
      let reached = false;
      for (let i = 0; i < 250 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate(() => document.activeElement?.dataset?.testid === "whatsapp-chat");
      }
      expectTrue(reached, "Tab never reached the WhatsApp button");
    }],
    ["At the bottom of the page it covers nothing in the footer", async () => {
      await goto(page, "/");
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(400);
      const box = await insideViewport();
      for (const target of [page.getByPlaceholder("Email Address"), page.getByText(/all rights reserved/i)]) {
        const t = await target.first().boundingBox();
        if (!t) continue;
        const overlap = !(t.x + t.width <= box.x || box.x + box.width <= t.x || t.y + t.height <= box.y || box.y + box.height <= t.y);
        expectTrue(!overlap, `overlaps ${await target.first().evaluate((e) => e.outerHTML.slice(0, 60))}`);
      }
    }],
    ["Steps aside for the sign-in modal, the quote modal and the cart drawer", async () => {
      await goto(page, `/products/${seeded.p4._id}/description`);
      await dismissNudge(page);
      await shown("load");
      await page.getByRole("button", { name: /add to bag/i }).click();
      await page.getByRole("dialog").waitFor({ timeout: 5_000 });
      await hidden("the sign-in modal");
      await page.keyboard.press("Escape");
      await shown("closing the sign-in modal");
      await page.getByRole("button", { name: /enquire now/i }).click();
      await hidden("the quote modal");
      // Clicked through the DOM: with the icon font blocked, the phone-width
      // product page overflows and the ✕ sits outside the 390px viewport
      // (a known, separate issue).
      await page.getByRole("button", { name: /close quote request/i }).dispatchEvent("click");
      await shown("closing the quote modal");
      await page.getByRole("button", { name: /^cart/i }).first().click();
      await hidden("the cart drawer");
    }],
    ...(viewport === "mobile"
      ? [["Steps aside for the phone menu", async () => {
          await goto(page, "/");
          await shown("load");
          await page.getByRole("button", { name: /open menu/i }).click();
          await hidden("the open menu");
          await page.getByRole("button", { name: /close menu/i }).click();
          await shown("closing the menu");
        }]]
      : []),
  ]);
  return context;
};

const runAdminFlows = async (browser, viewport, shared) => {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const productName = `E2E Bangle ${viewport}`;
  let previewPrice;

  await flow(viewport, "Admin", page, [
    ["Admin sign-in", async () => {
      await goto(page, "/admin-login");
      await page.locator('input[placeholder="Enter your email"]').fill(ADMIN_EMAIL);
      await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/admin-login"), { timeout: 15_000 });
    }],
    ["Out-of-bounds gold rate (₹96) shows an error and is not saved", async () => {
      await goto(page, "/dashboard/adminLiveRates");
      const gold = page.locator('input[placeholder="e.g. 13230"]');
      await gold.fill("96");
      await page.getByRole("button", { name: /save new rates/i }).click();
      await page.getByText(/gold rate must be between/i).first().waitFor({ timeout: 8_000 });
      const rates = (await api("GET", "/rates")).body;
      expectTrue(rates.gold.ratePerGram === 7250, `gold rate changed to ${rates.gold.ratePerGram}`);
    }],
    ["Valid gold rate is saved", async () => {
      const gold = page.locator('input[placeholder="e.g. 13230"]');
      await gold.fill("7300");
      await page.getByRole("button", { name: /save new rates/i }).click();
      await page.getByText(/live rates updated successfully/i).first().waitFor({ timeout: 8_000 });
      const rates = (await api("GET", "/rates")).body;
      expectTrue(rates.gold.ratePerGram === 7300, `gold rate is ${rates.gold.ratePerGram}`);
    }],
    ["Add product: live preview price", async () => {
      await goto(page, "/dashboard/adminAddProducts");
      await page.locator('[name="name"]').fill(productName);
      await page.locator('textarea[name="description"]').fill("E2E description text");
      await page.locator('select[name="metalType"]').selectOption("gold");
      await page.locator('[name="weight"]').fill("5");
      await page.locator('[name="wastagePercent"]').fill("10");
      await page.locator('[name="gstPercent"]').fill("3");
      await page.locator('[name="stock"]').fill("2");
      // B2: a discount must show in the preview and match what the API charges.
      await page.locator('[name="discountPercentage"]').fill("10");
      await page.getByText(/discount \(10%\)/i).first().waitFor({ timeout: 5_000 });
      await page.locator('select[name="category"]').selectOption({ label: "Gold" });
      await page.locator('input[type="file"]').setInputFiles({ name: "e2e.png", mimeType: "image/png", buffer: PNG_1PX });
      const text = await page.getByText(/customer price/i).locator("xpath=../..").innerText();
      // The box also shows the rate ("gold @ ₹7,300/g") and the breakdown rows;
      // the customer price is the largest figure in it.
      const amounts = [...text.matchAll(/₹\s?[\d,]+/g)].map((m) => parseRupees(m[0]));
      expectTrue(amounts.length, `no price in preview: ${text}`);
      previewPrice = Math.max(...amounts);
      return `preview ${rupees(previewPrice)}`;
    }],
    ["Publish; API price equals the preview", async () => {
      await page.getByRole("button", { name: /^publish$/i }).click();
      await page.getByRole("button", { name: /yes, publish it/i }).click();
      let created;
      for (let i = 0; i < 30 && !created; i++) {
        const list = (await api("GET", "/products")).body.data || [];
        created = list.find((p) => p.name === productName);
        if (!created) await page.waitForTimeout(300);
      }
      expectTrue(created, "product was not created");
      expectTrue(created.price === previewPrice, `API price ${created.price} ≠ preview ${previewPrice}`);
      // S9a fixed: the description typed in Add Product is saved.
      expectTrue(created.details?.description === "E2E description text" && created.description === "E2E description text", `description not saved: ${JSON.stringify({ description: created.description, details: created.details })}`);
      return `API ${rupees(created.price)} = preview`;
    }],
    ["Approve the customer's order", async () => {
      const mine = shared[viewport];
      expectTrue(mine?.orderId, "no customer order from the COD flow to approve");
      await goto(page, "/dashboard/adminOrders");
      await dismissNudge(page);
      const row = page.locator("tr", { has: page.getByRole("button", { name: /^approve$/i }) }).first();
      await row.waitFor({ timeout: 10_000 });
      // Approve every pending row belonging to this viewport's customer order.
      const order = (await api("GET", `/orders/${mine.orderId}`, { token: mine.token })).body.data;
      const target = page.locator("tr", { hasText: order.orderId }).first();
      const useRow = (await target.count()) ? target : row;
      await useRow.getByRole("button", { name: /^approve$/i }).click();
      const confirm = page.getByRole("button", { name: /^(yes|approve|confirm)/i }).last();
      if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click();
      let approved;
      for (let i = 0; i < 20 && !approved; i++) {
        const o = (await api("GET", `/orders/${mine.orderId}`, { token: mine.token })).body.data;
        if (o.approvalStatus === "APPROVED") approved = o;
        else await page.waitForTimeout(300);
      }
      expectTrue(approved, "order not approved");
      const days = (new Date(approved.expectedDeliveryDate) - new Date(approved.approvedAt)) / 86_400_000;
      expectTrue(days === 15, `expected delivery is ${days} days after approval`);
      mine.expected = approved.expectedDeliveryDate;
    }],
    ["Customer sees the expected delivery date", async () => {
      const mine = shared[viewport];
      await mine.page.reload({ waitUntil: "domcontentloaded" });
      await goto(mine.page, "/dashboard/myOrders");
      await mine.page.getByText(/expected delivery by/i).first().waitFor({ timeout: 10_000 });
      const text = await mine.page.getByText(/expected delivery by/i).first().innerText();
      return text;
    }],
    ["Users: search by phone, tap-to-call, sort by spend; no sensitive fields", async () => {
      // Deliver the order approved above, so its customer has spend (B6:
      // a COD order counts once delivered).
      const mine = shared[viewport];
      const token = await adminToken();
      for (const status of ["shipped", "delivered"]) {
        const r = await api("PATCH", `/orders/${mine.orderId}/status`, { token, body: { status } });
        expectTrue(r.status === 200, `mark ${status}: ${r.status} ${JSON.stringify(r.body)}`);
      }
      const rows = (await api("GET", "/users", { token })).body;
      for (const r of rows) {
        expectTrue(!/otp|password|token|hash/i.test(Object.keys(r).join(" ")), `sensitive field on a row: ${Object.keys(r)}`);
      }
      const top = [...rows].sort((a, b) => b.totalSpent - a.totalSpent)[0];
      const caller = rows.find((r) => r.phone && r.orderCount > 0) || rows.find((r) => r.phone);
      expectTrue(top && top.totalSpent > 0 && caller, `no customer with spend/phone to check: ${JSON.stringify(rows.map((r) => [r.name, r.orderCount, r.totalSpent]))}`);
      await goto(page, "/dashboard/adminUsers");
      await page.getByRole("searchbox", { name: /search users/i }).waitFor({ timeout: 10_000 });
      expectTrue((await page.locator('[data-testid="whatsapp-chat"]').count()) === 0, "WhatsApp button shown on the admin dashboard");
      const national = caller.phone.replace("+91", "");
      await page.getByRole("searchbox", { name: /search users/i }).fill(`${national.slice(0, 5)} ${national.slice(5)}`);
      const call = page.locator(`a[href="tel:${caller.phone}"]:visible`);
      await call.first().waitFor({ timeout: 8_000 });
      expectTrue((await call.count()) === 1, `tel link count ${await call.count()}`);
      const box = await call.first().boundingBox();
      expectTrue(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= page.viewportSize().width, `call link not tappable: ${JSON.stringify(box)}`);
      await page.getByRole("searchbox", { name: /search users/i }).fill("");
      await page.getByRole("combobox", { name: /sort users/i }).selectOption("spent_desc");
      const firstRow = viewport === "mobile" ? page.locator('ul[aria-label="Users"] > li').first() : page.locator("table tbody tr").first();
      const spentText = `₹${Number(top.totalSpent).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
      await firstRow.getByText(spentText, { exact: true }).waitFor({ timeout: 5_000 });
      return `${rows.length} users; top spend ${spentText}`;
    }],
  ]);

  return context;
};

const runLegalPages = async (browser, viewport) => {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const slugs = [
    "privacy-policy",
    "terms-of-service",
    "shipping-policy",
    "return-policy",
    "cancellation-policy",
    "security-policy",
    "responsible-disclosure",
    "accessibility-statement",
    "acceptable-use",
  ];
  await flow(viewport, "Legal pages", page, [
    ["/legal index", async () => {
      await goto(page, "/legal");
      await page.locator("h1").first().waitFor();
    }],
    ...slugs.map((s) => [
      `/legal/${s}`,
      async () => {
        await goto(page, `/legal/${s}`);
        await page.locator("h1").first().waitFor({ timeout: 8_000 });
        const h1 = await page.locator("h1").first().innerText();
        expectTrue(!/not found/i.test(h1), `h1 says "${h1}"`);
      },
    ]),
    ["Footer links point at real legal pages (not '/')", async () => {
      await goto(page, "/");
      const hrefs = await page.locator("footer a").evaluateAll((as) => as.map((a) => [a.innerText.trim(), a.getAttribute("href")]));
      const legalish = hrefs.filter(([t]) => /privacy|terms|shipping|return|refund|cancel/i.test(t));
      expectTrue(legalish.length > 0, "no legal links in footer");
      const bad = legalish.filter(([, h]) => !h || h === "/" || h === "#");
      expectTrue(bad.length === 0, `footer legal links pointing nowhere: ${JSON.stringify(bad)}`);
    }],
  ]);
  return context;
};

// ─── Main ────────────────────────────────────────────────────────────────────

const main = async () => {
  const mongod = await MongoMemoryServer.create();
  mongoUri = mongod.getUri();
  try {
    const apiEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development", // auth / OTP / form limiters off, as for local dev
      PORT: String(API_PORT),
      MONGODB_URI: `${mongod.getUri()}e2e`,
      JWT_SECRET: "e2e-jwt-secret-not-for-anything-else",
      // No email provider: development console mode prints each sign-in code
      // to the API log, which codeFor() reads. No test OTP.
      ADMIN_PASSWORD,
      ALLOWED_ORIGINS: WEB,
      PUBLIC_SITE_URL: WEB,
      CRON_SECRET: "e2e-cron",
      CLOUDINARY_URL: "cloudinary://111111111111111:e2e_secret@e2ecloud",
      DOTENV_CONFIG_QUIET: "true",
    };
    // cwd without a .env: dotenv would otherwise fill in the developer's real
    // secrets (Atlas URI, Razorpay …) for anything not set above.
    start("api", process.execPath, [path.join(ROOT, "server/index.js")], { cwd: NO_DOTENV, env: apiEnv });
    await waitFor(`${API}/rates`, "API");

    start("vite", process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(WEB_PORT), "--strictPort"], {
      cwd: ROOT,
      env: {
        ...process.env,
        VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
        BROWSER: "none",
        // A fixed test number, never the developer's .env value.
        VITE_WHATSAPP_NUMBER: WA_NUMBER,
        VITE_WHATSAPP_GREETING: WA_GREETING,
      },
    });
    await waitFor(WEB, "Vite");

    // Seed data comes from the app's own first-run seeding (p1…p5).
    const list = (await api("GET", "/products")).body.data;
    const seeded = Object.fromEntries(list.map((p) => [p.productId, p]));
    if (!seeded.p1 || !seeded.p4) throw new Error(`seed products missing: ${Object.keys(seeded)}`);

    const browser = await chromium.launch({ headless: !HEADED });
    const shared = {};
    for (const viewport of ["desktop", "mobile"]) {
      // Rates reset to the seeded value so each viewport sees the same prices.
      const ctxs = [];
      ctxs.push(await runCustomerFlows(browser, viewport, seeded, shared));
      ctxs.push(await runTimedPromptFlow(browser, viewport, seeded));
      ctxs.push(await runRegistrationFlow(browser, viewport, seeded));
      ctxs.push(await runWhatsAppChatFlow(browser, viewport, seeded));
      ctxs.push(await runAdminFlows(browser, viewport, shared));
      ctxs.push(await runLegalPages(browser, viewport));
      for (const c of ctxs) await c.close();
      // The admin flow set gold to 7300; put it back for the next viewport.
      await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      })
        .then((r) => r.json())
        .then((j) => api("PATCH", "/rates", { token: j.accessToken, body: { gold: 7250 } }));
      const again = (await api("GET", "/products")).body.data;
      Object.assign(seeded, Object.fromEntries(again.map((p) => [p.productId, p])));
    }
    await browser.close();
  } finally {
    await cleanup(mongod);
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  const summary = {};
  for (const r of results) {
    const k = `${r.viewport} · ${r.flow}`;
    summary[k] ??= { pass: 0, fail: 0, skipped: 0, finding: 0 };
    summary[k][r.status] += 1;
  }
  const errorsByPage = {};
  for (const e of consoleErrors) {
    const k = `${e.viewport} ${e.url}`;
    (errorsByPage[k] ??= new Set()).add(`[${e.kind}] ${e.text}`);
  }

  const out = {
    mobileHorizontalOverflow: Object.fromEntries([...overflow].filter(([, v]) => v)),
    results,
    summary,
    consoleErrors: Object.fromEntries(Object.entries(errorsByPage).map(([k, v]) => [k, [...v]])),
    blockedExternalHosts: Object.fromEntries(blockedRequests),
  };
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(out, null, 2));

  const pad = (s, n) => String(s).padEnd(n);
  console.log("\nE2E results");
  for (const [k, v] of Object.entries(summary)) {
    console.log(`  ${pad(k, 52)} pass ${v.pass}  fail ${v.fail}  skipped ${v.skipped}  findings ${v.finding}`);
  }
  for (const r of results.filter((r) => r.status === "fail")) {
    console.log(`\n  ✗ [${r.viewport}] ${r.flow} › ${r.step}\n    ${r.error.replace(/\n/g, "\n    ")}\n    url: ${r.url}\n    screenshot: ${r.screenshot}`);
  }
  for (const r of results.filter((r) => r.status === "finding")) {
    console.log(`\n  ⚑ [${r.viewport}] ${r.flow} › ${r.step}\n    ${r.note}`);
  }
  const overflowing = [...overflow].filter(([, v]) => v);
  console.log(`\n  390px pages checked: ${overflow.size}; scrolling sideways: ${overflowing.length}`);
  console.log(
    `  rate-limited (429) responses: ${rateLimited.length}` +
      (rateLimited.length ? ` — first at ${rateLimited[0].at} on ${rateLimited[0].path} (${rateLimited[0].where})` : "")
  );
  for (const [p, v] of overflowing) console.log(`    ${p}: scrollWidth ${v.scrollWidth}px — ${v.culprits.join(" | ")}`);
  console.log(`\n  console errors on ${Object.keys(errorsByPage).length} page(s); blocked external hosts: ${[...blockedRequests.keys()].join(", ") || "none"}`);
  console.log(`  details: ${path.relative(ROOT, path.join(OUT, "results.json"))}\n`);
  process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
};

main().catch(async (err) => {
  console.error(err);
  for (const c of children) c.kill("SIGTERM");
  process.exit(1);
});
