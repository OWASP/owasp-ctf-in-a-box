// GET /api/admin/status on a quiz-only event.
//
// The freshness block reports how many players the organizer's board has. On a
// quiz-only event the scoring source carries no rows at all (`emptySource`),
// and every contestant's row is CREATED by `withModuleContributions` — so
// counting the raw source reported `players: 0` forever, on a board the
// organizer could see was populated. This pins the count against the same
// overlay `/leaderboard` renders through.
//
// Own file for the usual `vi.mock` hoisting reason: the sibling routes.test.ts
// pins the event config to a module-less event.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getAdminSettings, getSyncStatus, getLeaderboardSource, getQuizTotals, listQuestions } =
  vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    getAdminSettings: vi.fn(),
    getSyncStatus: vi.fn(),
    getLeaderboardSource: vi.fn(),
    getQuizTotals: vi.fn(),
    listQuestions: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);
vi.mock("@/lib/admin-auth", () => ({ requireAdmin }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings, getSyncStatus }));
vi.mock("@/lib/leaderboard/source", () => ({ getLeaderboardSource }));
vi.mock("@/lib/quiz-store", () => ({ getQuizTotals, listQuestions, getTeamQuizTotalsBatch: vi.fn() }));

import { GET } from "@/app/api/admin/status/route";

beforeEach(() => {
  requireAdmin.mockResolvedValue({ ok: true, login: "alice" });
  getAdminSettings.mockResolvedValue({ paused: false });
  getSyncStatus.mockResolvedValue(null);
  listQuestions.mockResolvedValue([{ id: "q1" }, { id: "q2" }]);
  // The quiz-only scoring source: no rows, ever.
  getLeaderboardSource.mockResolvedValue({
    getLeaderboard: vi.fn().mockResolvedValue({
      entries: [],
      teams: [],
      generatedAt: "t",
      capabilities: { apps: false, teams: false, challenges: false },
    }),
  });
});

describe("GET /api/admin/status on a quiz-only event", () => {
  it("counts the contestants the leaderboard actually shows, not the empty source", async () => {
    getQuizTotals.mockResolvedValue(
      new Map([
        ["alice", { points: 30, answered: 2, lastAt: "2026-08-14T10:00:00.000Z" }],
        ["bob", { points: 10, answered: 1, lastAt: "2026-08-14T12:00:00.000Z" }],
      ]),
    );
    const body = await GET(new Request("http://x/api/admin/status")).then((r) => r.json());
    expect(body.leaderboard).toMatchObject({
      players: 2,
      lastUpdatedAt: "2026-08-14T12:00:00.000Z",
    });
  });

  it("still degrades to null when the source read fails", async () => {
    getQuizTotals.mockResolvedValue(new Map());
    getLeaderboardSource.mockResolvedValue({
      getLeaderboard: vi.fn().mockRejectedValue(new Error("source down")),
    });
    const res = await GET(new Request("http://x/api/admin/status"));
    expect(res.status).toBe(200);
    expect((await res.json()).leaderboard).toBeNull();
  });
});
