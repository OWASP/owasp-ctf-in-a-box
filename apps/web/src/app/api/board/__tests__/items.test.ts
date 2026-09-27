// /api/board/items — the expanded leaderboard rows' per-item quiz/classic/ai
// completion. The pins that matter: login validation (this is a public
// route), the members' UNION for team rosters, module gating, and that
// nothing grading-shaped can reach the payload.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isModuleLive: vi.fn<(id: string) => Promise<boolean>>(),
  listQuestions: vi.fn(),
  getViewerQuiz: vi.fn(),
  listChallenges: vi.fn(),
  getViewerClassic: vi.fn(),
  listAiChallenges: vi.fn(),
  getViewerAi: vi.fn(),
  getSession: vi.fn(),
  requireLaunchedApi: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/launch", () => ({ requireLaunchedApi: mocks.requireLaunchedApi }));
vi.mock("@/lib/enabled-modules", () => ({ isModuleLive: mocks.isModuleLive }));
vi.mock("@/lib/quiz-store", () => ({ listQuestions: mocks.listQuestions, getViewerQuiz: mocks.getViewerQuiz }));
vi.mock("@/lib/classic-store", () => ({ listChallenges: mocks.listChallenges, getViewerClassic: mocks.getViewerClassic }));
vi.mock("@/lib/ai-store", () => ({ listAiChallenges: mocks.listAiChallenges, getViewerAi: mocks.getViewerAi }));

import { GET } from "@/app/api/board/items/route";

const req = (logins: string) => new Request(`http://box/api/board/items?logins=${encodeURIComponent(logins)}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isModuleLive.mockResolvedValue(true);
  mocks.getSession.mockResolvedValue(null);
  mocks.requireLaunchedApi.mockResolvedValue(null);
  mocks.listQuestions.mockResolvedValue([{ id: "q1", prompt: "What is XSS?", points: 50 }]);
  mocks.getViewerQuiz.mockResolvedValue({ answered: {}, attempts: {} });
  mocks.listChallenges.mockResolvedValue([{ id: "c1", title: "Robots Only", points: 50 }]);
  mocks.getViewerClassic.mockResolvedValue({ solved: {}, attempts: {} });
  mocks.listAiChallenges.mockResolvedValue([{ id: "a1", title: "Prompt Leak", points: 50 }]);
  mocks.getViewerAi.mockResolvedValue({ solved: {}, attempts: {} });
});

describe("GET /api/board/items", () => {
  it("refuses malformed, empty, and oversized login lists", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("not a login!"))).status).toBe(400);
    expect((await GET(req(Array.from({ length: 9 }, (_, i) => `user-${i}`).join(",")))).status).toBe(400);
  });

  it("unions a roster: an item any member completed is done, with the banked points", async () => {
    mocks.getViewerQuiz.mockImplementation(async (login: string) => ({
      answered: login === "bob" ? { q1: { points: 50, at: "2026-08-24T00:00:00.000Z" } } : {},
      attempts: {},
    }));
    mocks.getViewerAi.mockImplementation(async (login: string) => ({
      solved: login === "bob" ? { a1: { points: 50, at: "2026-08-24T00:00:00.000Z", source: "flag" } } : {},
      attempts: {},
    }));
    const res = await GET(req("alice,bob"));
    const body = await res.json();
    expect(body.quiz).toEqual([{ id: "q1", label: "What is XSS?", points: 50, done: true, earnedPoints: 50 }]);
    expect(body.classic).toEqual([{ id: "c1", label: "Robots Only", points: 50, done: false }]);
    expect(body.ai).toEqual([{ id: "a1", label: "Prompt Leak", points: 50, done: true, earnedPoints: 50 }]);
  });

  it("returns null for a module that is not live, and never reads its store", async () => {
    mocks.isModuleLive.mockImplementation(async (id: string) => id === "quiz");
    const body = await (await GET(req("alice"))).json();
    expect(body.classic).toBeNull();
    expect(mocks.listChallenges).not.toHaveBeenCalled();
    expect(mocks.getViewerClassic).not.toHaveBeenCalled();
    expect(body.ai).toBeNull();
    expect(mocks.listAiChallenges).not.toHaveBeenCalled();
    expect(mocks.getViewerAi).not.toHaveBeenCalled();
  });

  // Simulates the leak this route must be immune to: a store record that
  // somehow carries grading material. Items are built field by field, so a
  // flag or an answer key on the source object has no path into the payload.
  it("never echoes grading fields from the public records", async () => {
    mocks.listChallenges.mockResolvedValue([
      { id: "c1", title: "Robots Only", points: 50, flag: "CTF{leak}", flagnorm: "ctf{leak}" },
    ]);
    mocks.listQuestions.mockResolvedValue([
      { id: "q1", prompt: "What is XSS?", points: 50, correct: ["a"] },
    ]);
    mocks.listAiChallenges.mockResolvedValue([
      { id: "a1", title: "Prompt Leak", points: 50, flag: "CTF{ai-leak}", hint: "psst", signingKey: "sk-secret" },
    ]);
    const text = await (await GET(req("alice"))).text();
    expect(text).not.toContain("CTF{leak}");
    expect(text).not.toContain("ctf{leak}");
    expect(text).not.toContain("correct");
    expect(text).not.toContain("CTF{ai-leak}");
    expect(text).not.toContain("psst");
    expect(text).not.toContain("sk-secret");
  });
});

describe("GET /api/board/items pre-launch lock (#464)", () => {
  it("refuses with 403 not-launched before launch, reading no challenge list", async () => {
    mocks.requireLaunchedApi.mockResolvedValue(Response.json({ error: "not-launched" }, { status: 403 }));
    const res = await GET(req("alice"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not-launched" });
    expect(mocks.listChallenges).not.toHaveBeenCalled();
    expect(mocks.listQuestions).not.toHaveBeenCalled();
    expect(mocks.listAiChallenges).not.toHaveBeenCalled();
  });

  it("asks the lock about the caller's session login, so an admin preview works", async () => {
    mocks.getSession.mockResolvedValue({ user: { login: "organizer" } });
    await GET(req("alice"));
    expect(mocks.requireLaunchedApi).toHaveBeenCalledWith("organizer");
  });

  it("treats a failed session read as signed out, not as an error", async () => {
    mocks.getSession.mockRejectedValue(new Error("bad cookie"));
    const res = await GET(req("alice"));
    expect(res.status).toBe(200);
    expect(mocks.requireLaunchedApi).toHaveBeenCalledWith(undefined);
  });
});
