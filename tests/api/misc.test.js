import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import { useApp } from "../helpers/app.js";

const ctx = useApp();

describe("harness", () => {
  it("uses the per-file in-memory database, never the .env Atlas URI", () => {
    expect(process.env.MONGODB_URI).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+\/t_/);
    expect(mongoose.connection.host).toBe("127.0.0.1");
  });

  it("runs from a directory with no .env, so dotenv cannot load real secrets", async () => {
    const fs = await import("node:fs");
    expect(process.cwd()).toMatch(/tests\/setup\/no-dotenv$/);
    expect(fs.existsSync(".env")).toBe(false);
    expect(process.env.JWT_SECRET).toBe(globalThis.__mocks.TEST_ENV.JWT_SECRET);
  });

  it("did not run seedInitialData (no seeded admin or products)", async () => {
    const { User } = await import("../../server/models/User.js");
    expect(await User.countDocuments()).toBe(0);
  });
});

describe("index routes", () => {
  it("GET /api/health responds without touching the DB", async () => {
    const res = await ctx.api().get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OK");
  });

  it("GET /api/nav-notifications returns the banner list", async () => {
    const res = await ctx.api().get("/api/nav-notifications");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("paths without the /api prefix are normalised (Vercel strips it)", async () => {
    const res = await ctx.api().get("/nav-notifications");
    expect(res.status).toBe(200);
  });

  it("unknown API path is a 404, not a 500", async () => {
    const res = await ctx.api().get("/api/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("CORS: allowed origin is echoed, disallowed origin gets no ACAO header and no crash", async () => {
    const ok = await ctx.api().get("/api/health").set("Origin", "http://localhost:5175");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5175");
    const bad = await ctx.api().get("/api/health").set("Origin", "https://evil.example");
    expect(bad.status).toBe(200);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("malformed JSON body is a 400, not a 500", async () => {
    const res = await ctx
      .api()
      .post("/api/contact")
      .set("Content-Type", "application/json")
      .send('{"name": "x", ');
    expect(res.status).toBe(400);
  });
});
