// /profile on a two-module event: both secure-development's per-app
// breakdown and the quiz's "answered / total" block must render, and the
// block COUNT must track the enabled-module list — not a per-module branch
// baked into the page. A third module registered here (with progress to
// show) would grow this count with no page edit; a hard-coded branch could
// not do that.
//
// Own file because `vi.mock` hoists per file and this fixture needs its own
// module set — same split as page-quiz-only.test.tsx and
// lib/__tests__/modules-resolve.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { getSession, getUser, getViewerTeam, getViewerHints, getQuizTotals, listQuestions } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    getUser: vi.fn(),
    getViewerTeam: vi.fn(),
    getViewerHints: vi.fn(),
    getQuizTotals: vi.fn(),
    listQuestions: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["secure-development", "quiz"]),
);
// An organizer rename, so the multi-module heading is demonstrably the
// RESOLVED title and not the registry default — same fixture the landing
// page's two-module test uses.
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({
    moduleOverrides: { quiz: { title: "Round 1" } },
    enabledModuleIds: ["secure-development", "quiz"],
  }),
  // The page reads the registration window for the team card's
  // closed-state explanation (issue #217).
  effectiveRegistrationOpen: () => true,
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/leaderboard/source", () => ({ getLeaderboardSource: async () => ({ getUser }) }));
vi.mock("@/lib/team-store", () => ({
  getViewerTeam,
  // The page renders the cap through the same resolver joinTeam enforces
  // with, so the mock has to provide it (issue #99).
  resolveTeamMaxMembers: async () => 4,
  TEAM_MAX_MEMBERS: 4,
  TEAM_WRITES_ENABLED: false,
}));
vi.mock("@/lib/hint-store", () => ({
  getViewerHints,
  getHintPenalties: vi.fn(),
  HINTS_AVAILABLE: false,
}));
vi.mock("@/lib/quiz-store", () => ({
  getQuizTotals,
  listQuestions,
  // The blocks' Show-N item list reads the viewer's own per-question map.
  getViewerQuiz: async () => ({ answered: {}, attempts: {} }),
}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: vi.fn() }));

import ProfilePage from "@/app/(site)/profile/page";

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { login: "ada", image: null } });
  getUser.mockResolvedValue({
    login: "ada",
    team: null,
    teamName: null,
    points: 40,
    maxPoints: 100,
    patched: 4,
    failed: 0,
    total: 6,
    apps: [{ app: "dvwa", points: 40, maxPoints: 100, patched: 4, total: 6 }],
    updatedAt: null,
  });
  getViewerTeam.mockResolvedValue(null);
  getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
  getQuizTotals.mockResolvedValue(new Map([["ada", { points: 15, answered: 3, lastAt: null }]]));
  listQuestions.mockResolvedValue([{}, {}, {}, {}, {}]);
});

describe("/profile on a two-module event", () => {
  it("shows both the secure-development and quiz blocks", async () => {
    const html = renderToStaticMarkup(await ProfilePage());
    expect(html).toContain(">4<"); // secure-development's per-app patched count (DVWA)
    expect(html).toContain("/ 6 patched");
    expect(html).toContain("/ 5 answered"); // quiz answered / total, via ProgressSummary
  });

  it("heads each block with that module's resolved title, in registry order", () => {
    return ProfilePage()
      .then(renderToStaticMarkup)
      .then((html) => {
        expect(html).toContain("Secure Development");
        expect(html).toContain("Round 1");
        expect(html.indexOf("Secure Development")).toBeLessThan(html.indexOf("Round 1"));
      });
  });

  // The point of this test: it counts BLOCKS, not modules by name. A
  // per-module `if`/branch bolted onto the page instead of driving off the
  // enabled-module list would still pass every assertion above while being
  // exactly the anti-pattern the brief forbids — this is what actually pins
  // "list-driven, not branch-driven".
  it("drives the block count off the enabled-module list, not a per-module branch", async () => {
    const html = renderToStaticMarkup(await ProfilePage());
    const blockCount = html.split('data-testid="module-block"').length - 1;
    expect(blockCount).toBe(2);
  });
});
