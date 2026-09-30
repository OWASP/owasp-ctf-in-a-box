// /profile on a quiz-only event: secure-development's own vocabulary
// (patched/total, the per-app breakdown, "target"/"challenge" in the page's
// own copy) must not appear anywhere, and the quiz module must contribute
// its own "answered / total" block.
//
// A hand-rolled `not.toContain("patched")` is exactly the kind of narrow
// assertion that left the hole this page shipped with (the header
// description read "...every target this event" and the metadata
// description said "...challenges" — both secure-development's own
// vocabulary, neither caught by a check for "patched" alone). Uses the
// shared, deliberately-exhaustive list from ../../__tests__/secure-dev-terms
// instead — the same one how-to-play's and rules' quiz-only suites use —
// so a future leak anywhere on this page fails here too.
//
// Own file because `vi.mock` hoists per file and this fixture needs its own
// module set — same split as lib/__tests__/modules-resolve.test.ts and
// app/__tests__/page-quiz-only.test.tsx. `@/lib/modules` is NOT mocked:
// only the live set is, so the real
// `resolveModules`/`getResolvedModules` pipeline still runs off the real
// registry — so this is also proof that a quiz-only event needs no
// per-module branch on this page.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findSecureDevLeaks } from "../../__tests__/secure-dev-terms";

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
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["quiz"]),
);
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` reads `moduleOverrides` from this; `enabledModuleIds`
  // mirrors the set the enabled-modules mock above serves.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["quiz"] }),
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

import ProfilePage, { generateMetadata } from "@/app/(site)/profile/page";

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { login: "ada", image: null } });
  getUser.mockResolvedValue({
    login: "ada",
    team: null,
    teamName: null,
    points: 0,
    maxPoints: 0,
    patched: 0,
    failed: 0,
    total: 0,
    apps: [],
    updatedAt: null,
  });
  getViewerTeam.mockResolvedValue(null);
  getViewerHints.mockResolvedValue({ purchased: {}, spent: 0, count: 0 });
  getQuizTotals.mockResolvedValue(new Map([["ada", { points: 15, answered: 3, lastAt: null }]]));
  listQuestions.mockResolvedValue([{}, {}, {}, {}, {}]);
});

describe("/profile on a quiz-only event", () => {
  it("shows a quiz contribution block when the module is enabled", async () => {
    const html = renderToStaticMarkup(await ProfilePage());
    // The block opens with the shared ProgressRow (spans split the pair)…
    expect(html).toContain("/ 5 answered");
    // …and that row IS the disclosure now, holding the five questions
    // directly instead of a second "Show N" toggle inside it.
    expect(html).toMatch(/<details[\s\S]*<ul/);
    expect(html.match(/<li /g)?.length).toBe(5);
  });

  // The list is enumerated, not sampled — see the file-level comment. This
  // is what would have caught the header description ("...every target this
  // event") and the metadata description ("...challenges"), neither of
  // which contains the literal substring "patched" the old assertion
  // checked for.
  it("renders no secure-development copy anywhere on the page", async () => {
    const html = renderToStaticMarkup(await ProfilePage());
    expect(findSecureDevLeaks(html)).toEqual([]);
  });

  it("keeps the page metadata module-agnostic too", async () => {
    const metadata = await generateMetadata();
    expect(findSecureDevLeaks(metadata.description as string)).toEqual([]);
  });
});
