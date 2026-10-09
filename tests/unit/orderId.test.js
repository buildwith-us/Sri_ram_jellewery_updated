import { describe, it, expect } from "vitest";
import { useApp } from "../helpers/app.js";
import { nextOrderId, ORDER_ID_PATTERN } from "../../server/utils/orderId.js";

useApp();

describe("nextOrderId — SRJ-YYYYMMDD-NNNN", () => {
  it("counts up from 0001, padded to four digits", async () => {
    const at = new Date("2026-10-09T06:00:00Z");
    expect(await nextOrderId(at)).toBe("SRJ-20261009-0001");
    expect(await nextOrderId(at)).toBe("SRJ-20261009-0002");
  });

  it("restarts at 0001 on a new day", async () => {
    await nextOrderId(new Date("2026-10-09T06:00:00Z"));
    expect(await nextOrderId(new Date("2026-10-10T06:00:00Z"))).toBe("SRJ-20261010-0001");
  });

  it("the day is the shop's (India time), not UTC", async () => {
    // 20:00 UTC on the 9th is 01:30 on the 10th in India.
    expect(await nextOrderId(new Date("2026-10-09T20:00:00Z"))).toBe("SRJ-20261010-0001");
  });

  it("goes past 9999 without breaking", async () => {
    const { Counter } = await import("../../server/models/Counter.js");
    await Counter.create({ _id: "order:20261011", seq: 9999 });
    const id = await nextOrderId(new Date("2026-10-11T06:00:00Z"));
    expect(id).toBe("SRJ-20261011-10000");
    expect(id).toMatch(ORDER_ID_PATTERN);
  });

  it("concurrent calls never share a number", async () => {
    const at = new Date("2026-10-12T06:00:00Z");
    const ids = await Promise.all(Array.from({ length: 50 }, () => nextOrderId(at)));
    expect(new Set(ids).size).toBe(50);
  });
});
