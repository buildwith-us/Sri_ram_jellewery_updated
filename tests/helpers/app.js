import mongoose from "mongoose";
import request from "supertest";
import { inject, beforeAll, beforeEach, afterAll } from "vitest";

let appPromise = null;

/**
 * Connect this test file to its own database on the shared in-memory mongod,
 * then import the Express app.
 *
 * The connection is made here, before server/index.js loads, and planted in the
 * cache connectDB() reads. That keeps connectDB from opening a second
 * connection and — more importantly — from running seedInitialData(), which
 * would drop five products and an admin into every test.
 */
export const startApp = () => {
  if (!appPromise) {
    appPromise = (async () => {
      const base = inject("mongoUri").replace(/\/$/, "");
      const dbName = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
      const uri = `${base}/${dbName}`;
      process.env.MONGODB_URI = uri;
      await mongoose.connect(uri);
      globalThis.__mongooseCache = { conn: mongoose, promise: null };
      const { default: app } = await import("../../server/index.js");
      // Build declared indexes (unique orderId, productId, email, phone) before
      // any test relies on them.
      await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
      return app;
    })();
  }
  return appPromise;
};

export const clearDb = async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
};

let ipCounter = 0;
/** A client address no other test in this file has used, so IP-keyed rate
 *  limiters start every test with a full allowance. */
export const nextIp = () => {
  ipCounter += 1;
  return `10.${(process.pid >> 8) & 255}.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
};

/**
 * `api(token?)` returns get/post/patch/delete builders with the test's client
 * IP and, optionally, a bearer token already attached.
 */
export const makeClient = (app, ipRef) => (token, { ip } = {}) => {
  const wrap = (method) => (url) => {
    let t = request(app)[method](url).set("X-Forwarded-For", ip || ipRef.current);
    if (token) t = t.set("Authorization", `Bearer ${token}`);
    return t;
  };
  return { get: wrap("get"), post: wrap("post"), patch: wrap("patch"), put: wrap("put"), delete: wrap("delete") };
};

/**
 * Standard hooks for an integration test file. Returns a context whose `app`
 * and `api` are populated once beforeAll has run.
 */
export const useApp = () => {
  const ipRef = { current: nextIp() };
  const ctx = { app: null, api: null, ipRef };

  beforeAll(async () => {
    ctx.app = await startApp();
    ctx.api = makeClient(ctx.app, ipRef);
  });

  beforeEach(async () => {
    ipRef.current = nextIp();
    await clearDb();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  return ctx;
};

export const mocks = () => globalThis.__mocks;
