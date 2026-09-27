// Route-level tests for the classic (flag) module's contestant submission
// route. Auth and classic-store are mocked — no Redis or GitHub session
// needed.
//
// login is ALWAYS derived from the session server-side; a body-supplied
// login must be ignored, since trusting it would be an account-impersonation
// hole. No response from this route may ever carry the submitted flag or a
// stored one — pinned explicitly below, not just inferred from status codes.

import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const { getSession, submitFlag, requireLaunchedApi, hasTeam, CLASSIC_ID_RE } = vi.hoisted(() => ({
  getSession: vi.fn(),
  submitFlag: vi.fn(),
  requireLaunchedApi: vi.fn(),
  hasTeam: vi.fn(),
  CLASSIC_ID_RE: /^[\w-]{1,64}$/,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/launch", () => ({ requireLaunchedApi }));
vi.mock("@/lib/classic-store", () => ({ submitFlag, CLASSIC_ID_RE }));
vi.mock("@/lib/team-store", () => ({ hasTeam }));

import { POST } from "@/app/api/classic/submit/route";

const req = (body?: unknown) =>
  new Request("http://x/api/classic/submit", { method: "POST", body: JSON.stringify(body ?? {}) });

const SESSION = { user: { login: "alice" } };

function session(login: string) {
  getSession.mockResolvedValue({ user: { login } });
}

function noSession() {
  getSession.mockResolvedValue(null);
}

function storeReturns(result: unknown) {
  submitFlag.mockResolvedValue(result);
}

beforeEach(() => {
  getSession.mockReset();
  submitFlag.mockReset();
  requireLaunchedApi.mockReset();
  hasTeam.mockReset();
  getSession.mockResolvedValue(SESSION);
  requireLaunchedApi.mockResolvedValue(null);
  hasTeam.mockResolvedValue(true);
});

describe("POST /api/classic/submit", () => {
  it("401s an unauthenticated request without touching the store", async () => {
    noSession();
    const res = await POST(req({ challengeId: "c-1", flag: "x" }));
    expect(res.status).toBe(401);
    expect(submitFlag).not.toHaveBeenCalled();
  });

  it("400s a session with no GitHub login, without touching the store", async () => {
    getSession.mockResolvedValue({ user: {} });
    const res = await POST(req({ challengeId: "c-1", flag: "x" }));
    expect(res.status).toBe(400);
    expect(submitFlag).not.toHaveBeenCalled();
  });

  it("403s with { error: \"not-launched\" } before launch (#464), without touching the store", async () => {
    session("alice");
    requireLaunchedApi.mockResolvedValue(Response.json({ error: "not-launched" }, { status: 403 }));
    const res = await POST(req({ challengeId: "c-1", flag: "x" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not-launched" });
    expect(submitFlag).not.toHaveBeenCalled();
  });

  // Covers both "gate active, valid unlock cookie" and "gate inactive" —
  // at this boundary they're the same case (requireLaunchedApi resolves
  // true either way); the active-vs-inactive distinction is exercised
  // directly against the real cookie/crypto logic in gate.test.ts.
  it("proceeds normally once launched (or for an admin preview)", async () => {
    session("alice");
    requireLaunchedApi.mockResolvedValue(null);
    storeReturns({ ok: true, correct: true, points: 50 });
    const res = await POST(req({ challengeId: "c-1", flag: "CTF{x}" }));
    expect(res.status).toBe(200);
    expect(submitFlag).toHaveBeenCalledWith("alice", "c-1", "CTF{x}");
  });

  // --- the team requirement (issue #153) ------------------------------------
  //
  // Scoring is per team: a teamless login's banked points fold into no team
  // total, so a solve that "counts" for nobody is worse than a refusal.

  it("403s with { error: \"no-team\" } for a teamless login, without touching the store", async () => {
    hasTeam.mockResolvedValue(false);
    const res = await POST(req({ challengeId: "c-1", flag: "CTF{x}" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no-team" });
    expect(submitFlag).not.toHaveBeenCalled();
  });

  it("refuses a teamless caller IDENTICALLY for a right and a wrong flag", async () => {
    // The refusal lands before the body is even parsed, so it cannot become an
    // oracle: a teamless caller must not be able to tell a correct flag from a
    // wrong one by the shape of the rejection.
    hasTeam.mockResolvedValue(false);
    const right = await POST(req({ challengeId: "c-1", flag: "CTF{correct}" }));
    const wrong = await POST(req({ challengeId: "c-1", flag: "nope" }));
    expect(right.status).toBe(wrong.status);
    expect(await right.json()).toEqual(await wrong.json());
  });

  it("asks about the SESSION's login, never a body-supplied one", async () => {
    hasTeam.mockResolvedValue(false);
    session("alice");
    await POST(req({ challengeId: "c-1", flag: "x", login: "mallory" }));
    expect(hasTeam).toHaveBeenCalledWith("alice");
  });

  it("checks the launch lock BEFORE the team, so a pre-launch caller is told that first", async () => {
    requireLaunchedApi.mockResolvedValue(Response.json({ error: "not-launched" }, { status: 403 }));
    hasTeam.mockResolvedValue(false);
    const res = await POST(req({ challengeId: "c-1", flag: "x" }));
    expect(await res.json()).toEqual({ error: "not-launched" });
    expect(hasTeam).not.toHaveBeenCalled();
  });

  it("derives login from the session and IGNORES any login in the body", async () => {
    session("alice");
    storeReturns({ ok: true, correct: false });
    await POST(req({ challengeId: "c-1", flag: "x", login: "mallory" }));
    expect(submitFlag).toHaveBeenCalledWith("alice", "c-1", "x");
  });

  it("400s a malformed challenge id and 404s an unknown one", async () => {
    session("alice");
    expect((await POST(req({ challengeId: "../etc", flag: "x" }))).status).toBe(400);
    expect(submitFlag).not.toHaveBeenCalled();

    storeReturns({ ok: false, reason: "invalid" });
    expect((await POST(req({ challengeId: "c-1", flag: "x" }))).status).toBe(404);
  });

  it("400s a missing/empty flag, without touching the store", async () => {
    session("alice");
    expect((await POST(req({ challengeId: "c-1" }))).status).toBe(400);
    expect((await POST(req({ challengeId: "c-1", flag: "" }))).status).toBe(400);
    expect((await POST(req({ challengeId: "c-1", flag: "   " }))).status).toBe(400);
    expect(submitFlag).not.toHaveBeenCalled();
  });

  it("400s a flag over the length cap, without touching the store", async () => {
    session("alice");
    const res = await POST(req({ challengeId: "c-1", flag: "x".repeat(513) }));
    expect(res.status).toBe(400);
    expect(submitFlag).not.toHaveBeenCalled();
  });

  it("never echoes the submitted flag back", async () => {
    session("alice");
    storeReturns({ ok: true, correct: false });
    const body = await (await POST(req({ challengeId: "c-1", flag: "CTF{secret}" }))).json();
    expect(JSON.stringify(body)).not.toContain("CTF{secret}");
  });

  it("200s with correct:true and points for a correct flag", async () => {
    session("alice");
    storeReturns({ ok: true, correct: true, points: 50 });
    const res = await POST(req({ challengeId: "c-1", flag: "CTF{x}" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ correct: true, points: 50 });
  });

  it("carries `already` through for a re-submitted correct flag", async () => {
    session("alice");
    storeReturns({ ok: true, correct: true, points: 0, already: true });
    const res = await POST(req({ challengeId: "c-1", flag: "CTF{x}" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ correct: true, points: 0, already: true });
  });

  it.each(["paused", "solved", "unavailable"] as const)(
    "403s a %s gate refusal",
    async (reason) => {
      session("alice");
      storeReturns({ ok: false, reason });
      const res = await POST(req({ challengeId: "c-1", flag: "x" }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: reason });
    },
  );

  it("403s a gate refusal and carries retryAt through", async () => {
    session("alice");
    storeReturns({ ok: false, reason: "cooldown", retryAt: "2026-08-19T10:00:00.000Z" });
    const res = await POST(req({ challengeId: "c-1", flag: "x" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cooldown", retryAt: "2026-08-19T10:00:00.000Z" });
  });

  it("503s when the grading script itself fails", async () => {
    session("alice");
    storeReturns({ ok: false, reason: "error" });
    const res = await POST(req({ challengeId: "c-1", flag: "x" }));
    expect(res.status).toBe(503);
  });
});
