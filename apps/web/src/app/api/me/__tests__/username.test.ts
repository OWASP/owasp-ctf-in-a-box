// POST /api/me/username: status mapping, the budget, and what is refused
// before any write. The store is mocked here; username-cookies.test.ts runs
// the real store and better-auth for the cookie refresh.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decoratedError, expectLabelOnly } from "@/lib/__tests__/log-redaction";

const player = { id: "0b9e4f3c-1d2a-4c5b-8e6f-7a8b9c0d1e2f", name: "Alice", image: null, githubLogin: "octocat", username: null };

const m = vi.hoisted(() => ({
  getPlayer: vi.fn(),
  setUsernameOnce: vi.fn(),
  consumeRateLimit: vi.fn(),
  getSession: vi.fn(),
  upstashEval: vi.fn(),
  realConsume: null as null | ((...a: never[]) => Promise<unknown>),
}));
vi.mock("server-only", () => ({}));
const SESSION_DATA = vi.hoisted(() => ({ name: "better-auth.session_data", attributes: { path: "/", httpOnly: true, sameSite: "lax", secure: false, maxAge: 300 } }));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: m.getSession }, $context: Promise.resolve({ authCookies: { sessionData: SESSION_DATA } }) },
}));
vi.mock("@/lib/upstash", () => ({ upstashEval: m.upstashEval }));
vi.mock("@/lib/player", () => ({ getPlayer: m.getPlayer }));
vi.mock("@/lib/username-store", () => ({ setUsernameOnce: m.setUsernameOnce }));
vi.mock("@/lib/rate-limit-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rate-limit-store")>();
  m.realConsume = real.consumeRateLimit as never;
  return { ...real, consumeRateLimit: m.consumeRateLimit };
});

import { POST } from "@/app/api/me/username/route";

const req = (body: unknown, cookie = "") =>
  new Request("http://box.test/api/me/username", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.getPlayer.mockResolvedValue(player);
  m.consumeRateLimit.mockResolvedValue({ allowed: true });
  m.setUsernameOnce.mockResolvedValue("ok");
  m.getSession.mockResolvedValue({
    headers: new Headers([["set-cookie", "better-auth.session_data=abc; Path=/"], ["set-cookie", "better-auth.session_token=def; Path=/"]]),
    response: { user: { username: "bob" } },
  });
});

describe("POST /api/me/username", () => {
  it("401s signed out and charges nothing", async () => {
    m.getPlayer.mockResolvedValue(null);
    const res = await POST(req({ username: "bob" }));
    expect(res.status).toBe(401);
    expect(m.consumeRateLimit).not.toHaveBeenCalled();
    expect(m.setUsernameOnce).not.toHaveBeenCalled();
  });

  it("charges the player's own fail-open budget", async () => {
    await POST(req({ username: "bob" }));
    expect(m.consumeRateLimit).toHaveBeenCalledWith("username-pick", player.id, 20, 600);
  });

  it("429s with Retry-After once the budget is spent, writing nothing", async () => {
    m.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const res = await POST(req({ username: "bob" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(m.setUsernameOnce).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 7, ["bob"], {}])("400s a non-string username %j before the store", async (username) => {
    const res = await POST(req({ username }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect(m.setUsernameOnce).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON", async () => {
    const res = await POST(req("{nope"));
    expect(res.status).toBe(400);
    expect(m.setUsernameOnce).not.toHaveBeenCalled();
  });

  it("maps invalid, taken and already_set", async () => {
    m.setUsernameOnce.mockResolvedValue("invalid");
    let res = await POST(req({ username: "x" }));
    expect([res.status, await res.json()]).toEqual([400, { error: "invalid" }]);
    m.setUsernameOnce.mockResolvedValue("taken");
    res = await POST(req({ username: "bob" }));
    expect([res.status, await res.json()]).toEqual([409, { error: "taken" }]);
    m.setUsernameOnce.mockResolvedValue("already_set");
    res = await POST(req({ username: "bob" }));
    expect([res.status, await res.json()]).toEqual([409, { error: "already_set" }]);
  });

  it("200s on ok, passing the session user id and the raw input", async () => {
    const res = await POST(req({ username: " Bob " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.setUsernameOnce).toHaveBeenCalledWith(player.id, " Bob ");
  });

  it("re-reads the session past the cookie cache and carries its cookies", async () => {
    const res = await POST(req({ username: "bob" }));
    expect(m.getSession).toHaveBeenCalledWith(
      expect.objectContaining({ query: { disableCookieCache: true }, returnHeaders: true }),
    );
    expect(res.headers.getSetCookie()).toEqual(["better-auth.session_data=abc; Path=/", "better-auth.session_token=def; Path=/"]);
  });

  it("carries refreshed cookies on already_set too, so a stale cache in another browser stops bouncing", async () => {
    m.setUsernameOnce.mockResolvedValue("already_set");
    const res = await POST(req({ username: "bob" }));
    expect(res.status).toBe(409);
    expect(m.getSession).toHaveBeenCalledWith(expect.objectContaining({ query: { disableCookieCache: true } }));
    expect(res.headers.getSetCookie()).toEqual(["better-auth.session_data=abc; Path=/", "better-auth.session_token=def; Path=/"]);
  });

  it.each(["taken", "invalid"] as const)("does not touch the cookies on %s", async (result) => {
    m.setUsernameOnce.mockResolvedValue(result);
    const res = await POST(req({ username: "bob" }));
    expect(m.getSession).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("expires the cookie cache (every chunk sent), not the session token, when the refresh fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.getSession.mockRejectedValue(decoratedError("store down"));
    const res = await POST(
      req({ username: "bob" }, "better-auth.session_token=t; better-auth.session_data.0=x; better-auth.session_data.1=y; other=z"),
    );
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie();
    const names = set.map((c) => c.split("=")[0]).sort();
    expect(names).toEqual(["better-auth.session_data", "better-auth.session_data.0", "better-auth.session_data.1"]);
    for (const c of set) expect(c).toMatch(/Max-Age=0/);
    expect(set.join("\n")).not.toContain("session_token");
    expectLabelOnly(err, { label: "store down" });
    err.mockRestore();
  });

  it("lets the pick through when the budget's store fails (fail open)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.consumeRateLimit.mockImplementation(m.realConsume as never);
    m.upstashEval.mockRejectedValue(new Error("redis down"));
    const res = await POST(req({ username: "bob" }));
    expect(m.upstashEval).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(m.setUsernameOnce).toHaveBeenCalled();
    err.mockRestore();
  });

  it("lets a store failure surface as a 500, not a success", async () => {
    m.setUsernameOnce.mockRejectedValue(decoratedError("redis down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req({ username: "bob" }));
    expect(res.status).toBe(500);
    expectLabelOnly(err, { label: "redis down" });
    err.mockRestore();
  });
});
