import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit-store")>()),
  consumeRateLimit: mocks.consume,
}));

import { limitAuthAttempt } from "@/lib/auth-rate-limit";

const ctx = (path: string, xff: string, body: unknown = {}) =>
  ({ path, headers: new Headers({ "x-forwarded-for": xff }), body }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consume.mockResolvedValue({ allowed: true });
});

describe("limitAuthAttempt", () => {
  it("keys sign-up on the rightmost address whatever the client prepends", async () => {
    for (let i = 0; i < 60; i++) await limitAuthAttempt(ctx("/sign-up/email", `${Math.random()}, 10.0.0.1`));
    expect(mocks.consume).toHaveBeenCalledTimes(60);
    for (const c of mocks.consume.mock.calls) {
      expect(c.slice(0, 4)).toEqual(["signup-ip", "10.0.0.1", 300, 600]);
      expect(c[4]).toEqual({ failClosed: true });
    }
  });

  it("charges the address then address|username on sign-in", async () => {
    await limitAuthAttempt(ctx("/sign-in/username", "9.9.9.9, 10.0.0.1", { username: " Alice " }));
    expect(mocks.consume.mock.calls.map((c) => c.slice(0, 4))).toEqual([
      ["signin-ip", "10.0.0.1", 600, 600],
      ["signin-user", "10.0.0.1|alice", 10, 900],
    ]);
  });

  it("throws 429 carrying the seconds, in the body and Retry-After", async () => {
    mocks.consume.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 42 });
    const err = await limitAuthAttempt(ctx("/sign-up/email", "10.0.0.1")).catch((e) => e);
    expect(err.statusCode).toBe(429);
    expect(err.body).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 42, message: "Too many attempts. Try again in 42 seconds." });
    expect(err.headers["Retry-After"]).toBe("42");
  });

  it("does not charge the per-user bucket when the address bucket refuses", async () => {
    mocks.consume.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 5 });
    await expect(limitAuthAttempt(ctx("/sign-in/username", "10.0.0.1", { username: "a" }))).rejects.toThrow();
    expect(mocks.consume).toHaveBeenCalledTimes(1);
  });

  // Each of these writes an OAuth state row, so a flood would fill the store.
  it.each(["/sign-in/social", "/link-social"])("charges the sign-in address bucket on %s", async (path) => {
    await limitAuthAttempt(ctx(path, "9.9.9.9, 10.0.0.1", { provider: "github" }));
    expect(mocks.consume.mock.calls.map((c) => c.slice(0, 5))).toEqual([["signin-ip", "10.0.0.1", 600, 600, { failClosed: true }]]);
  });

  it("refuses /sign-in/social with 429 when the address bucket is spent", async () => {
    mocks.consume.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7 });
    const err = await limitAuthAttempt(ctx("/sign-in/social", "10.0.0.1", { provider: "github" })).catch((e) => e);
    expect(err.statusCode).toBe(429);
    expect(err.body).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 7 });
  });

  it.each(["/callback/:id", "/get-session", "/sign-out", "/ok"])("charges nothing on %s", async (path) => {
    await limitAuthAttempt(ctx(path, "10.0.0.1"));
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});
