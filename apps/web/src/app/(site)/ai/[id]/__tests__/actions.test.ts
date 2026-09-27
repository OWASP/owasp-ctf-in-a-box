// The in-box flag form's server-side half (spec §6.1's 2026-09-02 amendment).
//
// `/api/ai/submit` is the EXTERNAL surface — it authenticates a launch token,
// not a cookie, and the token exists only in the launcher's href. So the form
// on `/ai/[id]` cannot call it, and submits through this Server Action
// instead. The action is therefore its own security boundary, and this suite
// is where that boundary is pinned: every gate the page ran is re-run here,
// in the same order, and NONE of them may be reachable-past. The assertion
// that carries the weight in each refusal test is `submitAiFlag` not having
// been called — a refusal that still wrote is not a refusal.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, isModuleLive, getLaunchAccess, hasTeam, submitAiFlag, logActivity } = vi.hoisted(() => ({
  getSession: vi.fn(),
  isModuleLive: vi.fn(),
  getLaunchAccess: vi.fn(),
  hasTeam: vi.fn(),
  submitAiFlag: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/enabled-modules", () => ({ isModuleLive }));
vi.mock("@/lib/launch", () => ({ getLaunchAccess }));
vi.mock("@/lib/team-store", () => ({ hasTeam }));
vi.mock("@/lib/ai-store", () => ({ submitAiFlag }));
vi.mock("@/lib/activity-log", () => ({ logActivity }));

import { submitAiFlagAction } from "@/app/(site)/ai/[id]/actions";

beforeEach(() => {
  vi.clearAllMocks();
  isModuleLive.mockResolvedValue(true);
  getLaunchAccess.mockResolvedValue({ allowed: true, preview: false });
  getSession.mockResolvedValue({ user: { login: "alice" } });
  hasTeam.mockResolvedValue(true);
  submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 40 });
});

describe("submitAiFlagAction gates", () => {
  it("refuses — without touching the store — when the module is not live", async () => {
    isModuleLive.mockResolvedValue(false);
    await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({ error: "unavailable" });
    expect(submitAiFlag).not.toHaveBeenCalled();
  });

  it("refuses — without touching the store — before launch (#464)", async () => {
    getLaunchAccess.mockResolvedValue({ allowed: false, preview: false });
    await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({ error: "not-launched" });
    expect(submitAiFlag).not.toHaveBeenCalled();
    // Refused before the team check, too — a pre-launch "not yet" comes first.
    expect(hasTeam).not.toHaveBeenCalled();
  });

  // No "the lock itself errors" case here: getLaunchAccess never throws — a
  // failed read already resolves as refused (lib/__tests__/launch.test.ts
  // pins that fail-closed direction).
  it("asks the lock about the session's login (an admin passes as a preview)", async () => {
    await submitAiFlagAction("a1", "CTF{x}");
    expect(getLaunchAccess).toHaveBeenCalledWith("alice");
  });

  it("refuses — without touching the store — for a signed-out caller", async () => {
    getSession.mockResolvedValue(null);
    await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({ error: "unauthorized" });
    expect(submitAiFlag).not.toHaveBeenCalled();
  });

  it("refuses a session with no GitHub login the same way", async () => {
    getSession.mockResolvedValue({ user: {} });
    await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({ error: "unauthorized" });
    expect(submitAiFlag).not.toHaveBeenCalled();
  });

  it("refuses — without touching the store — a signed-in caller with no team", async () => {
    hasTeam.mockResolvedValue(false);
    await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({ error: "no-team" });
    expect(submitAiFlag).not.toHaveBeenCalled();
  });

  // A REFUSAL, not a redirect: the page bounces a teamless viewer, but an
  // action reached anyway (a stale tab, a team left mid-event) has to answer
  // the form it was called from.
  it("never redirects — a teamless caller gets a result the form can render", async () => {
    hasTeam.mockResolvedValue(false);
    const result = await submitAiFlagAction("a1", "CTF{x}");
    expect(result).toHaveProperty("error");
  });

  // The team check fails OPEN — the opposite direction from the launch lock above:
  // an error must not drop a solve an entitled contestant is making. Mocked
  // to reject here purely to pin the action's OWN guard; `hasTeam` itself
  // already swallows a store error and resolves `true` (team-store.ts).
  it("completes the submit when the team check itself errors", async () => {
    hasTeam.mockRejectedValueOnce(new Error("redis down"));
    await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({
      correct: true,
      points: 40,
      already: false,
    });
    expect(submitAiFlag).toHaveBeenCalledWith("alice", "a1", "CTF{x}", { dryRun: false });
  });

  it("refuses an id that does not match AI_ID_RE before the store sees it", async () => {
    await expect(submitAiFlagAction("../../etc/passwd", "CTF{x}")).resolves.toEqual({ error: "invalid" });
    expect(submitAiFlag).not.toHaveBeenCalled();
  });

  it("refuses an empty flag, and one past the length cap, before the store sees it", async () => {
    await expect(submitAiFlagAction("a1", "   ")).resolves.toEqual({ error: "invalid" });
    await expect(submitAiFlagAction("a1", "x".repeat(513))).resolves.toEqual({ error: "invalid" });
    expect(submitAiFlag).not.toHaveBeenCalled();
  });

  // Order pin: the module check runs before the session read, so a disabled
  // module is not a way to probe whether a cookie is valid.
  it("checks the module before it ever reads the session", async () => {
    isModuleLive.mockResolvedValue(false);
    await submitAiFlagAction("a1", "CTF{x}");
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("submitAiFlagAction results", () => {
  it("grades through the store as the session's login, and reports a correct solve", async () => {
    submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 40 });
    await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({
      correct: true,
      points: 40,
      already: false,
    });
    expect(submitAiFlag).toHaveBeenCalledWith("alice", "a1", "CTF{x}", { dryRun: false });
  });

  it("keeps an already-banked solve distinguishable from a fresh one", async () => {
    submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 0, already: true });
    await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({
      correct: true,
      points: 0,
      already: true,
    });
  });

  it("reports a wrong flag as a plain incorrect answer", async () => {
    submitAiFlag.mockResolvedValue({ ok: true, correct: false });
    await expect(submitAiFlagAction("a1", "nope")).resolves.toEqual({ correct: false });
  });

  it("passes a cooldown's retryAt through, and every other refusal reason as-is", async () => {
    submitAiFlag.mockResolvedValue({ ok: false, reason: "cooldown", retryAt: "2026-09-02T00:00:00.000Z" });
    await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({
      error: "cooldown",
      retryAt: "2026-09-02T00:00:00.000Z",
    });

    for (const reason of ["paused", "solved", "unavailable", "invalid", "error", "wrong-mode"] as const) {
      submitAiFlag.mockResolvedValue({ ok: false, reason });
      await expect(submitAiFlagAction("a1", "CTF{x}")).resolves.toEqual({ error: reason });
    }
  });

  // The whole reason this action exists rather than a fetch to
  // `/api/ai/submit`: nothing token-shaped may cross back to the client.
  it("never returns a token, a flag or a key in any branch", async () => {
    submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 40 });
    const payload = JSON.stringify(await submitAiFlagAction("a1", "CTF{super-secret}"));
    expect(payload).not.toContain("CTF{super-secret}");
    expect(payload).not.toMatch(/token|signkey|launchkey/i);
  });
});

// The action is the third award surface (alongside api/ai/submit and
// api/ai/event) and must feed the activity log the way those two do — it was
// the one path a solve could take without leaving an "ai solve" row.
describe("submitAiFlagAction activity log", () => {
  it("logs a fresh solve exactly once, with the id and the path, never the flag", async () => {
    submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 40 });
    const response = await submitAiFlagAction("a1", "CTF{super-secret}");
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledWith("ai-solve", "alice", "a1 via flag");
    const detail = JSON.stringify(logActivity.mock.calls);
    expect(detail).not.toContain("CTF{super-secret}");
    expect(JSON.stringify(response)).not.toContain("CTF{super-secret}");
  });

  it("does not log an already-banked re-submission", async () => {
    submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 0, already: true });
    await submitAiFlagAction("a1", "CTF{x}");
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("does not log a wrong flag or a store refusal", async () => {
    submitAiFlag.mockResolvedValue({ ok: true, correct: false });
    await submitAiFlagAction("a1", "nope");
    submitAiFlag.mockResolvedValue({ ok: false, reason: "paused" });
    await submitAiFlagAction("a1", "CTF{x}");
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("does not log — and never reaches the store — when the submit is refused first", async () => {
    hasTeam.mockResolvedValue(false);
    await submitAiFlagAction("a1", "CTF{x}");
    expect(submitAiFlag).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
});

describe("submitAiFlagAction admin preview (#464)", () => {
  it("grades a preview admin's flag as a dry run", async () => {
    getLaunchAccess.mockResolvedValue({ allowed: true, preview: true });
    submitAiFlag.mockResolvedValue({ ok: true, correct: true, points: 40, dryRun: true });
    await submitAiFlagAction("a1", "CTF{x}");
    expect(submitAiFlag).toHaveBeenCalledWith("alice", "a1", "CTF{x}", { dryRun: true });
  });
});
