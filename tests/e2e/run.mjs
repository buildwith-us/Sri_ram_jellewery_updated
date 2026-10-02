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
const ADMIN_PASSWORD = "E2e-Admin-Pass!2026";
const HEADED = Boolean(process.env.E2E_HEADED);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ─── Process management ──────────────────────────────────────────────────────

const children = [];
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

const api = async (method, p, { token, body } = {}) => {
  const r = await fetch(`${API}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, body: json };
};

const tokenOf = (page) => page.evaluate(() => localStorage.getItem("sri-ram-access-token"));

let phoneSeq = 0;
const freshPhone = () => `9${String(Date.now() % 1e8).padStart(8, "0")}${++phoneSeq % 10}`;

const rupees = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const parseRupees = (s) => Number(String(s).replace(/[^\d.]/g, ""));

// ─── Browser setup ───────────────────────────────────────────────────────────

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

const newContext = async (browser, viewport) => {
  const size = viewport === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const context = await browser.newContext({
    viewport: size,
    isMobile: viewport === "mobile",
    hasTouch: viewport === "mobile",
    deviceScaleFactor: 1,
  });

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

const NUDGE_TEXT = "Sign in to save your favourites, track your orders, and check out faster.";

const attachConsole = (page, viewport) => {
  // The guest "please sign in" nudge reappears every 30 s and would block any
  // click behind it. Dismiss only that one; the purchase gate (a different
  // message) is something the flows interact with on purpose.
  page
    .addLocatorHandler(page.getByText(NUDGE_TEXT), async () => {
      await page.getByRole("button", { name: /continue browsing/i }).click();
    })
    .catch(() => {});
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

/** Close the periodic "please sign in" nudge if it is in the way. */
const dismissNudge = async (page) => {
  const btn = page.getByRole("button", { name: /continue browsing/i });
  if (await btn.isVisible().catch(() => false)) await btn.click();
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

const signInWithOtp = async (page, phone) => {
  await page.locator('input[type="tel"]').fill(phone);
  await page.getByRole("button", { name: /send otp/i }).click();
  await page.locator('input[placeholder="------"]').fill("123456");
  await page.getByRole("button", { name: /verify & continue/i }).click();
  // First sign-in: name/email step, then the onboarding screen.
  const nameInput = page.locator('input[placeholder="Enter your full name"]');
  await Promise.race([
    nameInput.waitFor({ timeout: 10_000 }),
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10_000 }),
  ]).catch(() => {});
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill("E2E Customer");
    await page.getByRole("button", { name: /^continue$/i }).click();
  }
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10_000 });
  if (new URL(page.url()).pathname === "/welcome") {
    await page.getByRole("button", { name: /start browsing/i }).click();
  }
};

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
      await page.getByRole("button", { name: /over ₹1l/i }).click();
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
      await page.getByText(rupees(p1.price)).first().waitFor({ timeout: 10_000 });
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

  await flow(viewport, "Add to bag → login → resume", page, [
    ["Guest ADD TO BAG opens the login prompt", async () => {
      await goto(page, `/products/${p1._id}/description`);
      await dismissNudge(page);
      await page.getByRole("button", { name: /add to bag/i }).click();
      await page.getByText(/sign in to add this piece to your bag/i).waitFor({ timeout: 5_000 });
    }],
    ["Prompt → /login", async () => {
      await page.getByRole("link", { name: /sign-in\/register/i }).click();
      await page.waitForURL(/\/login/);
    }],
    ["OTP sign-in with 123456", async () => {
      await signInWithOtp(page, phone);
      token = await tokenOf(page);
      expectTrue(token, "no access token in localStorage after sign-in");
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
      await page.getByText(rupees(p1.price)).first().waitFor();
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
      if (!/'FILL' 1/.test(fill)) {
        finding(viewport, "Wishlist add / remove", "F1", `Card heart stays unfilled after adding (fontVariationSettings=${fill}): ProductCard compares wishlist productId ("${p4.productId}") with product._id`);
      }
    }],
    ["Clicking the heart again removes it", async () => {
      const card = page.locator("article", { hasText: p4.name }).first();
      await card.hover().catch(() => {});
      await card.locator("button").first().click({ force: true });
      await page.waitForTimeout(1200);
      const wl = (await api("GET", "/wishlist", { token })).body;
      if (wl.length !== 0) {
        finding(viewport, "Wishlist add / remove", "F1", `Second heart click did not remove the item (wishlist still has ${wl.length}); it re-added instead`);
      }
    }],
    ["Remove from the Wishlist page", async () => {
      await goto(page, "/wishlist");
      await page.getByText(p4.name).first().waitFor({ timeout: 10_000 });
      await page.locator("main button").filter({ has: page.locator("span.material-symbols-outlined") }).first().click();
      await page.getByRole("button", { name: /yes, remove it/i }).click();
      await page.waitForTimeout(800);
      const wl = (await api("GET", "/wishlist", { token })).body;
      expectTrue(wl.length === 0, `wishlist still has ${wl.length} after removing on /wishlist`);
    }],
  ]);

  await flow(viewport, "UPI / QR SCAN checkout (bug S2)", page, [
    ["UPI 'order' completes with no payment step", async () => {
      await goto(page, `/products/${p4._id}/description`);
      await page.getByRole("button", { name: /buy now/i }).click();
      await page.waitForURL(/\/checkout/);
      await page.getByText("UPI / QR SCAN", { exact: true }).click();
      await page.getByRole("button", { name: /complete order/i }).click();
      await page.waitForURL(/\/order-success/, { timeout: 15_000 });
      const orders = (await api("GET", "/orders", { token })).body;
      const upi = orders.find((o) => o.paymentMethod === "upi");
      expectTrue(upi, "no upi order stored");
      finding(viewport, "UPI / QR SCAN checkout (bug S2)", "S2", `"Order Confirmed" shown; order ${upi.orderId} stored with paymentMethod=upi, paymentStatus=${upi.paymentStatus}, paidAt=${upi.paidAt} — nothing was paid, and the cron will expire it in 30 min`);
      await page.screenshot({ path: path.join(OUT, `${viewport}-evidence-upi-order-confirmed.png`), fullPage: true });
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
      await page.locator('[name="description"]').fill("E2E description text");
      await page.locator('select[name="metalType"]').selectOption("gold");
      await page.locator('[name="weight"]').fill("5");
      await page.locator('[name="wastagePercent"]').fill("10");
      await page.locator('[name="gstPercent"]').fill("3");
      await page.locator('[name="stock"]').fill("2");
      await page.locator('select[name="category"]').selectOption({ label: "Gold" });
      await page.locator('input[type="file"]').setInputFiles({ name: "e2e.png", mimeType: "image/png", buffer: PNG_1PX });
      const text = await page.getByText(/customer price/i).locator("xpath=../..").innerText();
      const m = text.match(/₹[\d,]+/);
      expectTrue(m, `no price in preview: ${text}`);
      previewPrice = parseRupees(m[0]);
      return `preview ${m[0]}`;
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
      if (!created.description && !created.details) {
        finding(viewport, "Admin", "S9a", `Description typed in Add Product was not saved (product ${created.productId} has no description/details)`);
      }
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
  try {
    const apiEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development", // auth / OTP / form limiters off, as for local dev
      PORT: String(API_PORT),
      MONGODB_URI: `${mongod.getUri()}e2e`,
      JWT_SECRET: "e2e-jwt-secret-not-for-anything-else",
      ALLOW_TEST_OTP: "true",
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
      env: { ...process.env, VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`, BROWSER: "none" },
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
