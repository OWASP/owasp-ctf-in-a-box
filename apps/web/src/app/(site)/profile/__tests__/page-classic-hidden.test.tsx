// The profile and a hidden Jeopardy challenge: it is out of the list, the
// denominators and the points ceiling, for a contestant who solved it too.
// The points they banked on it stay in their total, and one line names them
// ("+N pts from challenges no longer on the board") so the list still adds up. Same
// fixture as page.test.tsx, plus the classic module.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  getSession,
  getUser,
  getLeaderboard,
  getViewerTeam,
  getViewerHints,
  getHintPenalties,
  moduleLive,
  getQuizTotals,
  listQuestions,
  getAiTotals,
  listAiChallenges,
  getResolvedModules,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  getLeaderboard: vi.fn(),
  getViewerTeam: vi.fn(),
  getViewerHints: vi.fn(),
  getHintPenalties: vi.fn(),
  moduleLive: vi.fn(),
  getQuizTotals: vi.fn(),
  listQuestions: vi.fn(),
  getAiTotals: vi.fn(),
  listAiChallenges: vi.fn(),
  getResolvedModules: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules((id) => moduleLive(id)),
);
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
// TeamCard (rendered unconditionally by the profile page) calls useRouter —
// same reason quiz/__tests__/page.test.tsx mocks it for QuizBoard.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/leaderboard/source", () => ({ getLeaderboardSource: async () => ({ getUser, getLeaderboard }) }));
vi.mock("@/lib/team-store", () => ({
  getViewerTeam,
  // The page renders the cap through the same resolver joinTeam enforces
  // with, so the mock has to provide it (issue #99).
  resolveTeamMaxMembers: async () => 4,
  TEAM_MAX_MEMBERS: 4,
  TEAM_WRITES_ENABLED: false,
}));
vi.mock("@/lib/hint-store", () => ({ getViewerHints, getHintPenalties, HINTS_AVAILABLE: true }));
// The leaderboard penalty fold reads these from hint-config, not hint-store
// (#553 moved them so the store can import the fold); mock both or the fold
// sees the real, credential-less module and applies no penalty.
vi.mock("@/lib/hint-config", () => ({ getHintPenalties, HINTS_AVAILABLE: true }));
// The per-module block list is driven off this, not off `@/lib/modules`
// directly — these tests don't exercise the breakdown blocks, so an empty
// list is enough to keep the page from rendering any.
vi.mock("@/lib/resolved-modules", () => ({ getResolvedModules }));
vi.mock("@/lib/quiz-store", () => ({
  getQuizTotals,
  listQuestions,
  // The blocks' Show-N item list reads the viewer's own per-question map.
  getViewerQuiz: async () => ({ answered: {}, attempts: {} }),
}));
vi.mock("@/lib/ai-store", () => ({
  getAiTotals,
  listAiChallenges,
  // The blocks' Show-N item list reads the viewer's own per-challenge map.
  getViewerAi: async () => ({ solved: {}, attempts: {} }),
}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: vi.fn() }));

const classic = vi.hoisted(() => ({
  challenges: [] as Record<string, unknown>[],
  solved: {} as Record<string, { points: number; at: string }>,
  totals: new Map<string, { points: number; solved: number; lastAt: string | null }>(),
}));
vi.mock("@/lib/classic-store", () => ({
  listStories: async () => [],
  getClassicTotals: async () => classic.totals,
  getViewerClassic: async () => ({ solved: classic.solved, attempts: {} }),
  listChallenges: async () => classic.challenges,
}));
vi.mock("@/lib/classic-team", () => ({ unlockingSolvedIds: async () => new Set() }));

import ProfilePage from "@/app/(site)/profile/page";

const SECRET = "Withdrawn-title-k3";

beforeEach(() => {
  vi.clearAllMocks();
  moduleLive.mockImplementation((id: string) => id === "classic");
  getViewerTeam.mockResolvedValue(null);
  listQuestions.mockResolvedValue([]);
  listAiChallenges.mockResolvedValue([]);
  getResolvedModules.mockResolvedValue([{ id: "classic", nav: { href: "/flags", label: "Jeopardy" }, targets: [], title: "Jeopardy", blurb: "" }]);
  getSession.mockResolvedValue({ user: { login: "ada", image: null } });
  getUser.mockResolvedValue(null);
  getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
  classic.challenges = [
    { id: "c1", title: "Open One", category: "Web", description: "", points: 10, order: 0 },
    { id: "c2", title: "Open Two", category: "Web", description: "", points: 20, order: 1 },
    { id: "gone", title: SECRET, category: "Web", description: "", points: 30, order: 2, enabled: false },
  ];
  classic.solved = { c1: { points: 10, at: "2026-10-01T00:00:00.000Z" }, gone: { points: 30, at: "2026-10-01T00:00:00.000Z" } };
  classic.totals = new Map([["ada", { points: 40, solved: 2, lastAt: null }]]);
});

describe("profile and a hidden Jeopardy challenge", () => {
  it("keeps the banked points, names them in one line, and never names the challenge", async () => {
    const html = renderToStaticMarkup(await ProfilePage());
    expect(html).toContain("Open One");
    expect(html).not.toContain(SECRET);
    expect(html).toContain("+30 pts from challenges no longer on the board");
    expect(html).not.toContain("withdrawn");
    // The total keeps the 30.
    expect(html).toContain("40 of");
  });

  it("shows no off-the-board line when nothing banked is off the board", async () => {
    classic.solved = { c1: { points: 10, at: "2026-10-01T00:00:00.000Z" } };
    classic.totals = new Map([["ada", { points: 10, solved: 1, lastAt: null }]]);
    const html = renderToStaticMarkup(await ProfilePage());
    expect(html).not.toContain("no longer on the board");
  });

  it("leaves an unsolved hidden challenge out of the points ceiling", async () => {
    classic.solved = {};
    classic.totals = new Map([["ada", { points: 0, solved: 0, lastAt: null }]]);
    const html = renderToStaticMarkup(await ProfilePage());
    // 10 + 20 visible; the hidden 30 would make it 60.
    expect(html).toContain("0 of 30 pts available");
    expect(html).not.toContain("of 60 pts");
  });
});

describe("profile and a deleted Jeopardy challenge", () => {
  it("counts points banked on a deleted challenge in the same line", async () => {
    // `old` is not in the challenge list at all: deleted, not hidden.
    classic.solved = { c1: { points: 10, at: "2026-10-01T00:00:00.000Z" }, old: { points: 15, at: "2026-10-01T00:00:00.000Z" } };
    classic.totals = new Map([["ada", { points: 25, solved: 2, lastAt: null }]]);
    const html = renderToStaticMarkup(await ProfilePage());
    expect(html).toContain("+15 pts from challenges no longer on the board");
  });
});
