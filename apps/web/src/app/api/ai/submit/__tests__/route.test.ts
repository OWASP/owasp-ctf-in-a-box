// Route-level tests for the ai module's flag submission. Everything below the
// route is mocked — no Redis, no crypto.
//
// This route is COOKIE-BLIND on purpose: identity comes from the token and
// nothing else. The test that pins that is the one that matters most here,
// because "just read the session too" is the natural-looking change that
// would quietly reintroduce CSRF on a CORS `*` endpoint.
import { beforeEach, describe, expect, it, vi } from "vitest";
// #464: a preview token is honoured only while the event is not launched.
const aiPreview = vi.hoisted(() => ({ previewClaimStillValid: vi.fn(async () => true) }));
vi.mock("@/lib/ai-preview", () => aiPreview);
// #495: the module switch. Kept out of `mocks` (which beforeEach resets to
// no implementation) so every test runs with ai ON unless it says otherwise.
const modules = vi.hoisted(() => ({ isModuleLive: vi.fn<(id: string) => Promise<boolean>>(async () => true) }));
vi.mock("@/lib/enabled-modules", () => modules);

const mocks = vi.hoisted(() => ({
  verifyLaunchToken: vi.fn(),
  decodeTokenUnverified: vi.fn(),
  getAiLaunchPublicKey: vi.fn(),
  listAiChallenges: vi.fn(),
  submitAiFlag: vi.fn(),
  consumeRateLimit: vi.fn(),
  hasTeam: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai-token", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-token")>()),
  verifyLaunchToken: mocks.verifyLaunchToken,
  decodeTokenUnverified: mocks.decodeTokenUnverified,
}));
vi.mock("@/lib/ai-store", () => ({
  getAiLaunchPublicKey: mocks.getAiLaunchPublicKey,
  listAiChallenges: mocks.listAiChallenges,
  submitAiFlag: mocks.submitAiFlag,
}));
vi.mock("@/lib/rate-limit-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit-store")>()),
  consumeRateLimit: mocks.consumeRateLimit,
}));
vi.mock("@/lib/team-store", () => ({ hasTeam: mocks.hasTeam }));
vi.mock("@/lib/activity-log", () => ({ logActivity: mocks.logActivity }));

import { OPTIONS, POST } from "@/app/api/ai/submit/route";

const CHAL = "prompt-leak-ab12cd";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x/api/ai/submit", { method: "POST", body: JSON.stringify(body), headers });

/** The happy path's fixture: a decodable, verifiable token for CHAL. */
function tokenIsGood(sub = "alice") {
  mocks.decodeTokenUnverified.mockReturnValue({ sub, aud: CHAL, jti: "n1" });
  mocks.getAiLaunchPublicKey.mockResolvedValue("-----BEGIN PUBLIC KEY-----test");
  mocks.verifyLaunchToken.mockReturnValue({ ok: true, claims: { sub, aud: CHAL, jti: "n1" } });
  mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "both", points: 300 }]);
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.hasTeam.mockResolvedValue(true);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  modules.isModuleLive.mockReset();
  modules.isModuleLive.mockResolvedValue(true);
});

describe("POST /api/ai/submit", () => {
  // --- the module switch (#495) ---------------------------------------------
  //
  // Switching ai off in /admin 404s its board; this token-authenticated path
  // must refuse too, or the external challenge site keeps banking points.

  it("403s with { error: \"unavailable\" } when ai is switched off, before the token is read or anything is graded (#495)", async () => {
    tokenIsGood();
    modules.isModuleLive.mockResolvedValue(false);
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });

    const res = await POST(post({ token: "t", flag: "CTF{x}" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "unavailable" });
    // Still CORS-readable, like every answer from this route family.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(modules.isModuleLive).toHaveBeenCalledWith("ai");
    // First check: no token oracle, no rate-limit spend, no grade, no log.
    expect(mocks.decodeTokenUnverified).not.toHaveBeenCalled();
    expect(mocks.verifyLaunchToken).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.submitAiFlag).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("answers an invalid token the same 403 while ai is off — a disabled module is no token oracle (#495)", async () => {
    tokenIsGood();
    mocks.verifyLaunchToken.mockReturnValue({ ok: false, error: "invalid-signature" });
    modules.isModuleLive.mockResolvedValue(false);
    const res = await POST(post({ token: "forged", flag: "CTF{x}" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("awards a correct flag and answers with CORS headers", async () => {
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });

    const res = await POST(post({ token: "t", flag: "CTF{x}" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ correct: true, points: 300, already: false });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // Identity came from the token, never the body.
    expect(mocks.submitAiFlag).toHaveBeenCalledWith("alice", CHAL, "CTF{x}", { dryRun: false });
  });

  it("logs a fresh correct solve to the activity log, naming the flag path", async () => {
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });
    await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(mocks.logActivity).toHaveBeenCalledWith("ai-solve", "alice", `${CHAL} via flag`);
  });

  it("does not log an already-banked resubmission", async () => {
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 0, already: true });
    await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("does not log a wrong flag", async () => {
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: false });
    await POST(post({ token: "t", flag: "nope" }));
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("does not log any refusal (bad token, no team, unknown challenge, wrong mode, store refusal)", async () => {
    tokenIsGood();
    mocks.verifyLaunchToken.mockReturnValue({ ok: false, error: "expired" });
    await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(mocks.logActivity).not.toHaveBeenCalled();

    tokenIsGood();
    mocks.hasTeam.mockResolvedValue(false);
    await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(mocks.logActivity).not.toHaveBeenCalled();

    tokenIsGood();
    mocks.listAiChallenges.mockResolvedValue([]);
    await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(mocks.logActivity).not.toHaveBeenCalled();

    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: false, reason: "paused" });
    await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("never lets a submitted flag reach the logged detail", async () => {
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });
    await POST(post({ token: "t", flag: "CTF{super-secret-flag}" }));
    expect(mocks.logActivity).toHaveBeenCalledWith("ai-solve", "alice", `${CHAL} via flag`);
    const detail = mocks.logActivity.mock.calls[0][2];
    expect(detail).not.toContain("CTF{super-secret-flag}");
  });

  it("ignores a login in the body — identity is the token's subject", async () => {
    tokenIsGood("alice");
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });

    await POST(post({ token: "t", flag: "CTF{x}", login: "mallory", sub: "mallory" }));

    expect(mocks.submitAiFlag).toHaveBeenCalledWith("alice", CHAL, "CTF{x}", { dryRun: false });
  });

  it("never reads a session cookie", async () => {
    // A cookie on the request must change nothing. If this route ever starts
    // reading one, CSRF is back on a CORS `*` endpoint.
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });

    const res = await POST(post({ token: "t", flag: "CTF{x}" }, { cookie: "better-auth.session=zzz" }));

    expect(res.status).toBe(200);
    expect(mocks.submitAiFlag).toHaveBeenCalledWith("alice", CHAL, "CTF{x}", { dryRun: false });
  });

  it("reports a wrong flag without awarding", async () => {
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: false });
    const res = await POST(post({ token: "t", flag: "nope" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ correct: false });
  });

  it("marks an idempotent resubmission as already banked", async () => {
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 0, already: true });
    expect(await (await POST(post({ token: "t", flag: "CTF{x}" }))).json()).toEqual({
      correct: true,
      points: 0,
      already: true,
    });
  });

  it("refuses an unverifiable token, an expired one, and one for another challenge", async () => {
    for (const [error, status, body] of [
      ["invalid-signature", 401, "invalid-token"],
      ["malformed", 401, "invalid-token"],
      ["expired", 401, "expired"],
      ["audience", 401, "invalid-token"],
    ] as const) {
      tokenIsGood();
      mocks.verifyLaunchToken.mockReturnValue({ ok: false, error });
      const res = await POST(post({ token: "t", flag: "CTF{x}" }));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: body });
      expect(mocks.submitAiFlag).not.toHaveBeenCalled();
    }
  });

  it("404s a challenge that no longer exists, without calling the store's grader", async () => {
    tokenIsGood();
    mocks.listAiChallenges.mockResolvedValue([]);
    const res = await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown-challenge" });
    expect(mocks.submitAiFlag).not.toHaveBeenCalled();
  });

  it("reads no per-challenge secret at all — a launch token needs only the public key", async () => {
    // Only /event reads ctf:ai:signkey. If this route ever starts, a public
    // CORS-* endpoint is holding a secret it has no use for.
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });
    await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(mocks.verifyLaunchToken).toHaveBeenCalledWith("t", expect.any(String), { audience: CHAL });
  });

  it("refuses a flag submission against an event-only challenge", async () => {
    tokenIsGood();
    mocks.listAiChallenges.mockResolvedValue([{ id: CHAL, mode: "event", points: 300 }]);
    const res = await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wrong-mode" });
    expect(mocks.submitAiFlag).not.toHaveBeenCalled();
  });

  it("refuses a teamless solver, and the check is the ROUTE's, not the store's", async () => {
    // Scoring is per team; a teamless login's points fold into no team total.
    // PR 1's store never took this on, matching classic/submit's split.
    tokenIsGood();
    mocks.hasTeam.mockResolvedValue(false);
    const refused = await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "no-team" });
    expect(mocks.submitAiFlag).not.toHaveBeenCalled();

    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });
    expect((await POST(post({ token: "t", flag: "CTF{x}" }))).status).toBe(200);
  });

  it("maps every store refusal to its documented status", async () => {
    for (const [reason, status, extra] of [
      ["paused", 403, {}],
      ["solved", 409, {}],
      ["unavailable", 503, {}],
      ["error", 503, {}],
      ["invalid", 400, {}],
    ] as const) {
      tokenIsGood();
      mocks.submitAiFlag.mockResolvedValue({ ok: false, reason });
      const res = await POST(post({ token: "t", flag: "CTF{x}" }));
      expect(res.status, reason).toBe(status);
      expect(await res.json()).toEqual({ error: reason, ...extra });
    }
  });

  it("passes the cooldown's retryAt through with a 429", async () => {
    tokenIsGood();
    const retryAt = "2026-08-31T12:00:05.000Z";
    mocks.submitAiFlag.mockResolvedValue({ ok: false, reason: "cooldown", retryAt });
    const res = await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "cooldown", retryAt });
  });

  it("rate limits per token subject, with Retry-After", async () => {
    tokenIsGood();
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const res = await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(mocks.submitAiFlag).not.toHaveBeenCalled();
    // The literal budget, not `expect.any(Number)` — all three token-authed
    // routes pin theirs the same way, so a route that borrows a sibling's
    // limit is a failure rather than an unnoticed loosening.
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith("ai-submit", "alice", 60, 60);
  });

  it("rejects a malformed body, an empty flag and an oversized flag", async () => {
    for (const body of [{}, { token: "t" }, { token: "t", flag: "   " }, { token: "t", flag: "x".repeat(513) }]) {
      tokenIsGood();
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(mocks.submitAiFlag).not.toHaveBeenCalled();
    }
  });

  it("answers a preflight", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("never echoes the submitted flag back", async () => {
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: false });
    const res = await POST(post({ token: "t", flag: "CTF{secret}" }));
    expect(await res.text()).not.toContain("CTF{secret}");
  });
});

describe("POST /api/ai/submit with a preview token (#464)", () => {
  it("grades a preview admin's flag as a dry run and says so in the answer", async () => {
    tokenIsGood();
    mocks.verifyLaunchToken.mockReturnValue({ ok: true, claims: { sub: "alice", aud: CHAL, jti: "n1", ctf: { preview: true } } });
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300, dryRun: true });
    const res = await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ correct: true, points: 300, already: false, dryRun: true });
    expect(mocks.submitAiFlag).toHaveBeenCalledWith("alice", CHAL, "CTF{x}", { dryRun: true });
  });
});

describe("a preview token after launch, or on a teamless admin (#464)", () => {
  const previewClaims = { sub: "alice", aud: CHAL, jti: "n1", ctf: { preview: true } };

  it("is refused once the event has launched — never graded dry, never graded for real", async () => {
    tokenIsGood();
    mocks.verifyLaunchToken.mockReturnValue({ ok: true, claims: previewClaims });
    aiPreview.previewClaimStillValid.mockResolvedValueOnce(false);
    const res = await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid-token" });
    expect(mocks.submitAiFlag).not.toHaveBeenCalled();
  });

  it("grades a teamless preview admin (dry) — a dry run banks nothing to fold into a team", async () => {
    tokenIsGood();
    mocks.verifyLaunchToken.mockReturnValue({ ok: true, claims: previewClaims });
    mocks.hasTeam.mockResolvedValue(false);
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300, dryRun: true });
    const res = await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(res.status).toBe(200);
  });

  it("a normal token never asks whether a preview is still valid", async () => {
    aiPreview.previewClaimStillValid.mockClear();
    tokenIsGood();
    mocks.submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 300 });
    await POST(post({ token: "t", flag: "CTF{x}" }));
    expect(aiPreview.previewClaimStillValid).not.toHaveBeenCalled();
  });
});
