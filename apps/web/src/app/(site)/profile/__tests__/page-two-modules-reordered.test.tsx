// The actual proof that the per-module block loop is driven off the
// resolved-module LIST and not a hard-coded branch pair.
//
// `page-two-modules.test.tsx`'s block-count assertion does NOT prove this: a
// mutation that replaces the loop with
// `{moduleProgress["secure-development"] && <Block/>}{moduleProgress["quiz"]
// && <Block/>}` — exactly the anti-pattern this page must avoid — still
// emits 2 blocks on a 2-module fixture, so a count check alone passes both
// the real implementation and the regression.
//
// What a hard-coded branch pair (in registry-order writing) still gets
// right is ORDER — issue #386 removed the organizer-declared order entirely:
// `resolveModules` now always orders its result by the REGISTRY
// (`ALL_MODULE_IDS`), never by the Set's iteration order or by the order a
// fixture happens to declare (see modules-resolve.test.ts, "orders the
// result by the registry, regardless of the set's own order"). This
// fixture's admin-store mock (below) names quiz BEFORE secure-development —
// the reverse of page-two-modules.test.tsx — specifically to prove that
// declaration order is IGNORED: the block loop still renders
// secure-development first, because that is the registry's order. A block
// loop keyed off the input's own order (the pre-#386 behaviour) would get
// this backwards.
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
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz", "secure-development"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["quiz", "secure-development"] }),
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

describe("/profile block order follows the registry, not event.yaml's declaration order", () => {
  it("renders the secure-development block before quiz's even though the organizer declared quiz first", async () => {
    const html = renderToStaticMarkup(await ProfilePage());
    const quizAt = html.indexOf(">Quiz<");
    const secureDevAt = html.indexOf(">Secure Development<");
    expect(quizAt).toBeGreaterThanOrEqual(0);
    expect(secureDevAt).toBeGreaterThanOrEqual(0);
    expect(secureDevAt).toBeLessThan(quizAt);
  });
});
