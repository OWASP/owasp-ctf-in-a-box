// POST /api/me/password: status mapping, the budget, and what is refused
// before any write. better-auth is mocked here; the real hash-and-sign-in
// proof is in auth-store-better-auth.upstash.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const player = { id: "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f", name: "Alice", image: null, githubLogin: "octocat", username: "alice" };

const m = vi.hoisted(() => ({
  getPlayer: vi.fn(),
  setPassword: vi.fn(),
  consumeRateLimit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { setPassword: m.setPassword } } }));
vi.mock("@/lib/player", () => ({ getPlayer: m.getPlayer }));
vi.mock("@/lib/rate-limit-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit-store")>()),
  consumeRateLimit: m.consumeRateLimit,
}));

import { POST } from "@/app/api/me/password/route";

const req = (body: unknown) =>
  new Request("http://box.test/api/me/password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "better-auth.session_token=abc" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const apiError = (code: string) => Object.assign(new Error(code), { body: { code, message: code }, status: "BAD_REQUEST" });

beforeEach(() => {
  vi.clearAllMocks();
  m.getPlayer.mockResolvedValue(player);
  m.consumeRateLimit.mockResolvedValue({ allowed: true });
  m.setPassword.mockResolvedValue({ status: true });
});

describe("POST /api/me/password", () => {
  it("401s signed out and charges nothing", async () => {
    m.getPlayer.mockResolvedValue(null);
    const res = await POST(req({ newPassword: "p".repeat(12) }));
    expect(res.status).toBe(401);
    expect(m.consumeRateLimit).not.toHaveBeenCalled();
    expect(m.setPassword).not.toHaveBeenCalled();
  });

  it("charges the player's own budget", async () => {
    await POST(req({ newPassword: "p".repeat(12) }));
    expect(m.consumeRateLimit).toHaveBeenCalledWith("set-password", player.id, 10, 600);
  });

  it("429s with Retry-After once the budget is spent, writing nothing", async () => {
    m.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const res = await POST(req({ newPassword: "p".repeat(12) }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(m.setPassword).not.toHaveBeenCalled();
  });

  it("200s and hands better-auth the request headers and exactly the password", async () => {
    const res = await POST(req({ newPassword: "p".repeat(12) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const arg = m.setPassword.mock.calls[0][0] as { headers: Headers; body: unknown };
    expect(arg.body).toEqual({ newPassword: "p".repeat(12) });
    expect(arg.headers.get("cookie")).toContain("session_token");
  });

  it("409s already_set when a credential account exists", async () => {
    m.setPassword.mockRejectedValue(apiError("PASSWORD_ALREADY_SET"));
    const res = await POST(req({ newPassword: "p".repeat(12) }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_set" });
  });

  it.each(["PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG"])("400s length on %s", async (code) => {
    m.setPassword.mockRejectedValue(apiError(code));
    const res = await POST(req({ newPassword: "p".repeat(11) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "length" });
  });

  it.each([{}, { newPassword: 12 }, { newPassword: null }, "not json", "[]"])("400s invalid on body %j without calling better-auth", async (body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid");
    expect(m.setPassword).not.toHaveBeenCalled();
  });

  it("500s unavailable on any other failure, without echoing it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.setPassword.mockRejectedValue(new Error("redis exploded"));
    const res = await POST(req({ newPassword: "hunter2hunter2" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(err.mock.calls.flat().join(" ")).not.toContain("hunter2hunter2");
    err.mockRestore();
  });
});
