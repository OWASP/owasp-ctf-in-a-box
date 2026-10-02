// Route-level tests for the hints reveal route. Auth, hint-store, and the
// pre-event gate are all mocked — no Redis or GitHub session needed.
//
// This route is gated like classic/submit and quiz/answer, but is a sharper
// case: an ungated call here doesn't just bank points early, it hands back
// hint TEXT — challenge content leaked before the event opens. The gate
// check must run before revealHint is ever called.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, revealHint, resolveHintConfig, requireLaunchedApi, launchApiAccess, consumeRateLimit } = vi.hoisted(() => ({
  getSession: vi.fn(),
  revealHint: vi.fn(),
  resolveHintConfig: vi.fn(),
  requireLaunchedApi: vi.fn(),
  launchApiAccess: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/launch", () => ({ requireLaunchedApi, launchApiAccess }));
vi.mock("@/lib/hint-store", () => ({ revealHint, resolveHintConfig }));
// Mocked EXPLICITLY rather than left to load for real. The real module fails
// open on any Upstash error, so an unmocked import would quietly make every
// test in this file exercise the error branch and pass — coverage of the one
// path we are not trying to test here.
vi.mock("@/lib/rate-limit-store", () => ({
  consumeRateLimit,
  RATE_LIMITS: { hintReveal: { bucket: "hint-reveal", limit: 30, windowSeconds: 60 } },
}));

import { POST } from "@/app/api/hints/reveal/route";

const req = (body?: unknown) =>
  new Request("http://x/api/hints/reveal", { method: "POST", body: JSON.stringify(body ?? {}) });

const SESSION = { user: { login: "alice" } };

beforeEach(() => {
  getSession.mockReset();
  revealHint.mockReset();
  resolveHintConfig.mockReset();
  requireLaunchedApi.mockReset();
  consumeRateLimit.mockReset();
  getSession.mockResolvedValue(SESSION);
  requireLaunchedApi.mockResolvedValue(null);
  launchApiAccess.mockImplementation(async (login: string) => ({ refused: await requireLaunchedApi(login), preview: false }));
  consumeRateLimit.mockResolvedValue({ allowed: true });
  // Deliberately DIFFERENT from the revealHint fixture's charged cost (10):
  // the response must echo the amount revealHint actually charged, so if the
  // route regressed to a second resolveHintConfig() read this mock's 999 would
  // surface and fail the `cost: 10` assertion below.
  resolveHintConfig.mockResolvedValue({ enabled: true, cost: 999 });
});

describe("POST /api/hints/reveal rate limiting", () => {
  it("429s without revealing anything once the budget is spent", async () => {
    consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const res = await POST(req({ app: "quiz", id: "q1" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    // The whole point: the refusal must come BEFORE the store is touched, so
    // it can never follow a charge that already landed.
    expect(revealHint).not.toHaveBeenCalled();
  });

  it("charges the budget against the session login, not anything client-supplied", async () => {
    revealHint.mockResolvedValue({ ok: true, hint: "look at the query", alreadyOwned: false, spent: 10, cost: 10 });
    await POST(req({ app: "quiz", id: "q1", login: "someone-else" }));
    expect(consumeRateLimit).toHaveBeenCalledWith("hint-reveal", "alice", 30, 60);
  });

  it("does not charge an unauthenticated caller", async () => {
    getSession.mockResolvedValue(null);
    await POST(req({ app: "quiz", id: "q1" }));
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("stays behind the pre-event gate — a gated call is refused before it is charged", async () => {
    requireLaunchedApi.mockResolvedValue(Response.json({ error: "not-launched" }, { status: 403 }));
    const res = await POST(req({ app: "quiz", id: "q1" }));
    expect(res.status).toBe(403);
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/hints/reveal", () => {
  it("401s an unauthenticated request without touching the store", async () => {
    getSession.mockResolvedValue(null);
    const res = await POST(req({ app: "quiz", id: "q1" }));
    expect(res.status).toBe(401);
    expect(revealHint).not.toHaveBeenCalled();
  });

  it("400s a session with no GitHub login, without touching the store", async () => {
    getSession.mockResolvedValue({ user: {} });
    const res = await POST(req({ app: "quiz", id: "q1" }));
    expect(res.status).toBe(400);
    expect(revealHint).not.toHaveBeenCalled();
  });

  it("403s with { error: \"not-launched\" } before launch (#464), without revealing anything", async () => {
    requireLaunchedApi.mockResolvedValue(Response.json({ error: "not-launched" }, { status: 403 }));
    const res = await POST(req({ app: "quiz", id: "q1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not-launched" });
    expect(revealHint).not.toHaveBeenCalled();
  });

  // Covers both "launched" and "admin preview" — at this boundary they're the
  // same case (requireLaunchedApi resolves null either way); the distinction
  // is exercised directly in lib/__tests__/launch.test.ts.
  it("proceeds normally once launched (or for an admin preview)", async () => {
    requireLaunchedApi.mockResolvedValue(null);
    revealHint.mockResolvedValue({ ok: true, hint: "look under the rug", alreadyOwned: false, spent: 10, cost: 10 });
    const res = await POST(req({ app: "quiz", id: "q1" }));
    expect(res.status).toBe(200);
    expect(revealHint).toHaveBeenCalledWith("alice", "quiz", "q1", { dryRun: false });
    expect(await res.json()).toEqual({ hint: "look under the rug", alreadyOwned: false, spent: 10, cost: 10 });
  });

  it("404s when the hint is missing", async () => {
    revealHint.mockResolvedValue({ ok: false, error: "missing", missing: true });
    const res = await POST(req({ app: "quiz", id: "nope" }));
    expect(res.status).toBe(404);
  });

  it("403s when the store forbids the reveal (anti-burner gate)", async () => {
    revealHint.mockResolvedValue({ ok: false, error: "forbidden", forbidden: true });
    const res = await POST(req({ app: "quiz", id: "q1" }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/hints/reveal admin preview (#464)", () => {
  it("reveals a preview admin's hint as a dry run (nothing charged)", async () => {
    launchApiAccess.mockResolvedValueOnce({ refused: null, preview: true });
    revealHint.mockResolvedValue({ ok: true, hint: "look at the query", alreadyOwned: false, spent: 0, dryRun: true });
    const res = await POST(req({ app: "classic", id: "c1" }));
    expect(res.status).toBe(200);
    expect(revealHint).toHaveBeenCalledWith(expect.any(String), "classic", "c1", { dryRun: true });
    // The UI says "not charged" off this flag.
    expect((await res.json()).dryRun).toBe(true);
  });

  it("never asks for a dry run once launched", async () => {
    revealHint.mockResolvedValue({ ok: true, hint: "x", alreadyOwned: false, spent: 10 });
    await POST(req({ app: "classic", id: "c1" }));
    expect(revealHint).toHaveBeenCalledWith(expect.any(String), "classic", "c1", { dryRun: false });
  });
});
