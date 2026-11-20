import { describe, expect, it } from "vitest";
import { cooldownResponse, retryAfterSeconds } from "@/lib/cooldown-response";

describe("retryAfterSeconds", () => {
  const nowMs = Date.parse("2026-11-10T12:00:00.000Z");

  it("rounds fractional seconds up to the next whole second", () => {
    const retryAt = new Date(nowMs + 41_200).toISOString();
    expect(retryAfterSeconds(retryAt, nowMs)).toBe(42);
  });

  it("returns exact whole seconds when the delta is an integer number of seconds", () => {
    const retryAt = new Date(nowMs + 30_000).toISOString();
    expect(retryAfterSeconds(retryAt, nowMs)).toBe(30);
  });

  it("clamps zero, past, missing, and unparseable instants to at least 1", () => {
    expect(retryAfterSeconds(new Date(nowMs).toISOString(), nowMs)).toBe(1);
    expect(retryAfterSeconds(new Date(nowMs - 5_000).toISOString(), nowMs)).toBe(1);
    expect(retryAfterSeconds(undefined, nowMs)).toBe(1);
    expect(retryAfterSeconds("not-a-timestamp", nowMs)).toBe(1);
  });
});

describe("cooldownResponse", () => {
  const nowMs = Date.parse("2026-11-10T12:00:00.000Z");

  it("answers 429 with Retry-After header and { error: 'cooldown', retryAt } body", async () => {
    const retryAt = new Date(nowMs + 15_400).toISOString();
    const res = cooldownResponse(retryAt, nowMs);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("16");
    expect(await res.json()).toEqual({ error: "cooldown", retryAt });
  });

  it("omits retryAt from body when absent while still setting Retry-After: 1", async () => {
    const res = cooldownResponse(undefined, nowMs);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.json()).toEqual({ error: "cooldown" });
  });
});
