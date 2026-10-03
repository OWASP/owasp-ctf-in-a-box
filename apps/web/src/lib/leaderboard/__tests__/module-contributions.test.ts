import { beforeEach, describe, expect, it, vi } from "vitest";
import { apps } from "@/lib/apps";
import type { AiChallenge, AiTotal } from "@/lib/ai-store";
import type { LeaderboardData, LeaderboardEntry, TeamStanding } from "../types";
import { rankByStanding } from "../rank";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules((id) => mocks.moduleLive(id)),
);

const mocks = vi.hoisted(() => ({
  moduleLive: vi.fn((id: string) => id === "secure-development"),
  getQuizTotals: vi.fn(),
  getTeamQuizTotalsBatch: vi.fn(),
  listQuestions: vi.fn(),
  getClassicTotals: vi.fn(),
  getTeamClassicTotalsBatch: vi.fn(),
  listChallenges: vi.fn(),
  getAiTotals: vi.fn(),
  getTeamAiTotalsBatch: vi.fn(),
  listAiChallenges: vi.fn(),
}));

vi.mock("@/lib/modules", () => ({
  enabledModules: [{ id: "secure-development", displayName: "Secure Development", description: "", targets: ["dvwa"] }],
}));

vi.mock("@/lib/quiz-store", () => ({
  getQuizTotals: mocks.getQuizTotals,
  getTeamQuizTotalsBatch: mocks.getTeamQuizTotalsBatch,
  listQuestions: mocks.listQuestions,
}));

vi.mock("@/lib/classic-store", () => ({
  getClassicTotals: mocks.getClassicTotals,
  getTeamClassicTotalsBatch: mocks.getTeamClassicTotalsBatch,
  listChallenges: mocks.listChallenges,
}));

vi.mock("@/lib/ai-store", () => ({
  getAiTotals: mocks.getAiTotals,
  getTeamAiTotalsBatch: mocks.getTeamAiTotalsBatch,
  listAiChallenges: mocks.listAiChallenges,
}));

import {
  withModuleContributions,
  withTeamAiPoints,
  withTeamClassicPoints,
  withTeamQuizPoints,
} from "../module-contributions";
import { decoratedError, expectLabelOnly } from "@/lib/__tests__/log-redaction";

// Computed from the `apps` catalogue rather than hardcoded:
// `withModuleContributions` reads the live target total through
// `lib/enabled-apps.ts`'s `getEnabledTotals()`, which — with no admin
// settings stored (the mocked `@/lib/enabled-modules` double above resolves
// `getAdminSettingsSnapshot()` to null) — falls back to the default of all
// six, filtered against this SAME real `apps` catalogue. Computing it here
// off the same source keeps this test honest without pinning a number that
// would silently drift from the catalogue.
const enabledTotalChallenges = apps.reduce((sum, a) => sum + a.challengeCount, 0);

const entry = (login: string, points: number, patched: number, lastSolveAt = "2026-08-01T10:00:00.000Z"): LeaderboardEntry => ({
  rank: 0, login, team: null, points, patched, failed: 0, total: 3,
  apps: { dvwa: { app: "dvwa", points, maxPoints: 30, patched, total: 3 } },
  updatedAt: null, lastSolveAt,
});

const data = (entries: LeaderboardEntry[], teams: TeamStanding[] = []): LeaderboardData => ({
  entries: entries.map((e, i) => ({ ...e, rank: i + 1 })),
  teams,
  generatedAt: "2026-08-01T00:00:00.000Z",
  capabilities: { apps: true, teams: teams.length > 0, challenges: false },
});

/** Quiz and classic disabled by default (only secure-development enabled),
 *  matching what a box with a non-empty SCORE_IMAGE and no `/admin` changes
 *  enables — the default module set. Tests that need one of the app-side
 *  modules override this. */
beforeEach(() => {
  vi.clearAllMocks();
  mocks.moduleLive.mockImplementation((id: string) => id === "secure-development");
  mocks.getQuizTotals.mockResolvedValue(new Map());
  mocks.getTeamQuizTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map(() => ({ points: 0, answered: 0, lastAt: null }))),
  );
  mocks.listQuestions.mockResolvedValue([]);
  mocks.getClassicTotals.mockResolvedValue(new Map());
  mocks.getTeamClassicTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map(() => ({ points: 0, solved: 0, lastAt: null }))),
  );
  mocks.listChallenges.mockResolvedValue([]);
  mocks.getAiTotals.mockResolvedValue(new Map());
  mocks.getTeamAiTotalsBatch.mockImplementation((teams: readonly string[][]) =>
    Promise.resolve(teams.map(() => ({ points: 0, solved: 0, lastAt: null }))),
  );
  mocks.listAiChallenges.mockResolvedValue([]);
});

describe("withModuleContributions", () => {
  it("attributes the source's points to secure-development without double counting", async () => {
    const out = await withModuleContributions(data([entry("ada", 30, 3)]));
    const mod = out.entries[0].modules!["secure-development"]!;
    expect(out.entries[0].points).toBe(30); // unchanged
    expect(mod).toMatchObject({ points: 30, completed: 3, lastActivityAt: "2026-08-01T10:00:00.000Z" });
    expect(mod.detail).toEqual({ kind: "secure-development", apps: out.entries[0].apps });
  });

  it("re-ranks unconditionally, so ordering never depends on the hint overlay", async () => {
    const out = await withModuleContributions(data([entry("bob", 10, 1), entry("ada", 30, 3)]));
    expect(out.entries.map((e) => [e.login, e.rank])).toEqual([["ada", 1], ["bob", 2]]);
  });

  it("leaves a source with no per-app data alone rather than inventing a module", async () => {
    const bare = { ...entry("ada", 30, 3), apps: {} };
    const out = await withModuleContributions({ ...data([bare]), capabilities: { apps: false, teams: false, challenges: false } });
    expect(out.entries[0].modules).toEqual({});
  });

  it("passes teams through untouched", async () => {
    // Team rows get no quiz overlay here when the quiz module is disabled
    // (the default) or when the source has no deduped team data yet.
    const teams = [{ rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada"] }];
    const out = await withModuleContributions({ ...data([entry("ada", 30, 3)]), teams });
    expect(out.teams).toEqual(teams);
    expect(mocks.getTeamQuizTotalsBatch).not.toHaveBeenCalled();
  });

  // The expanded team row's module chips render from `team.modules`. Without
  // this attribution a team showed QUIZ and CLASSIC point chips while the
  // secure-development share of its total appeared nowhere — a captain adding
  // up the chips came out short and read it as a scoring bug.
  it("attributes a secure-development block to a team with app data, without changing its points", async () => {
    const apps = { dvwa: { app: "dvwa" as const, points: 30, maxPoints: 30, patched: 3, total: 3 } };
    const teams: TeamStanding[] = [
      { rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada"], apps },
    ];
    const out = await withModuleContributions({ ...data([entry("ada", 30, 3)]), teams });
    expect(out.teams[0].points).toBe(30); // attributed, never added
    expect(out.teams[0].modules?.["secure-development"]).toMatchObject({
      points: 30,
      completed: 3,
      detail: { kind: "secure-development", apps },
    });
  });

  // upstash carries no per-app data and no modules map, so completedCount
  // falls back to `patched`. Points come first, so the raw ZRANGE
  // points-descending order stands; `patched` only breaks a points tie, the
  // same way it does on lambda/mock. Pinned here so neither half drifts.
  it("keeps an upstash-shaped board's points order and breaks its ties on patched", async () => {
    const bare = (login: string, points: number, patched: number) => ({
      ...entry(login, points, patched), apps: {},
    });
    const out = await withModuleContributions({
      // ZRANGE order: points descending, ties in arrival order.
      ...data([bare("scorer", 90, 1), bare("fewer", 20, 1), bare("more", 20, 4)]),
      capabilities: { apps: false, teams: false, challenges: false },
    });
    expect(out.entries.map((e) => [e.login, e.rank])).toEqual([["scorer", 1], ["more", 2], ["fewer", 3]]);
    expect(out.entries.every((e) => Object.keys(e.modules ?? {}).length === 0)).toBe(true);
  });

  // Regression gate for the whole project: with only secure-development
  // configured, a populated module (completed === patched, lastActivityAt
  // === lastSolveAt) must rank identically to rankByStanding's own
  // patched/lastSolveAt fallback, with no overlay applied.
  it("ranks identically to the pre-overlay patched/lastSolveAt fallback", async () => {
    const raw = [
      entry("ada", 30, 3, "2026-08-01T09:00:00.000Z"),
      entry("carol", 30, 3, "2026-08-01T08:00:00.000Z"), // same points/completed, earlier activity
      entry("bob", 10, 1, "2026-08-01T10:00:00.000Z"),
    ];

    const before = rankByStanding(raw).map((e) => [e.login, e.rank]);
    const out = await withModuleContributions(data(raw));

    expect(out.entries.map((e) => [e.login, e.rank])).toEqual(before);

    for (const e of out.entries) {
      const mod = e.modules!["secure-development"]!;
      expect(mod.completed).toBe(e.patched);
      expect(mod.lastActivityAt).toBe(e.lastSolveAt);
    }
  });

  // Regression gate: with the quiz module DISABLED, the leaderboard must
  // behave EXACTLY as with no quiz module present — no quiz reads, no quiz
  // block, no ranking change driven by quiz data.
  describe("with the quiz module disabled", () => {
    it("never reads quiz data and adds no quiz block", async () => {
      const out = await withModuleContributions(data([entry("ada", 30, 3)]));
      expect(out.entries[0].modules!["quiz"]).toBeUndefined();
      expect(out.entries[0].points).toBe(30);
      expect(mocks.getQuizTotals).not.toHaveBeenCalled();
      expect(mocks.listQuestions).not.toHaveBeenCalled();
    });

    it("creates no rows — a disabled module contributes no points to create one from", async () => {
      const out = await withModuleContributions(data([]));
      expect(out.entries).toEqual([]);
      expect(mocks.getQuizTotals).not.toHaveBeenCalled();
    });
  });

  describe("with the quiz module enabled", () => {
    beforeEach(() => {
      mocks.moduleLive.mockImplementation((id: string) => id === "secure-development" || id === "quiz");
      mocks.listQuestions.mockResolvedValue([{ id: "q1" }, { id: "q2" }, { id: "q3" }]);
    });

    it("adds quiz points to the entry's total and renders a quiz module with completed = answered count", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["ada", { points: 15, answered: 2, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      // ADDED, not attributed: 30 (secure-dev, unchanged) + 15 (quiz) = 45.
      expect(out.entries[0].points).toBe(45);
      const quiz = out.entries[0].modules!["quiz"]!;
      expect(quiz).toMatchObject({ points: 15, completed: 2 });
      expect(quiz.detail).toEqual({ kind: "quiz", answered: 2, total: 3, points: 15 });
      // secure-development's own attribution is untouched by the addition.
      expect(out.entries[0].modules!["secure-development"]).toMatchObject({ points: 30, completed: 3 });
    });

    // The board's login set is the UNION of the source's logins and the
    // logins holding module points. Without that union the overlay maps only
    // over rows the scoring backend has already produced, so a contestant
    // whose only points are quiz points has no row to overlay onto and never
    // appears at all.
    it("creates a row for a contestant with quiz points and no scored submission", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["cyd", { points: 30, answered: 3, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      const cyd = out.entries.find((e) => e.login === "cyd")!;
      expect(cyd.points).toBe(30);
      // No scoring entry behind this row, so nothing that comes from the
      // scorer may be non-zero on it.
      expect(cyd).toMatchObject({ patched: 0, failed: 0, total: 0, apps: {}, team: null });
      expect(cyd.modules!["secure-development"]).toBeUndefined();
      expect(cyd.modules!["quiz"]).toMatchObject({ points: 30, completed: 3 });
    });

    // C3: secure-development's points are ATTRIBUTED (already inside
    // `entry.points`), quiz points are ADDED. A login in BOTH sources must
    // therefore end up as ONE row whose total is 10 + 30 — never two rows, and
    // never 10 + 30 + 30.
    it("counts a login present in both sources once", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["ada", { points: 30, answered: 3, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("ada", 10, 1)]));

      expect(out.entries).toHaveLength(1);
      expect(out.entries[0].points).toBe(40);
      expect(out.entries[0].modules!["secure-development"]!.points).toBe(10);
      expect(out.entries[0].modules!["quiz"]!.points).toBe(30);
    });

    // The scorer records the PR author's login; the quiz records the session's.
    // Matching them exactly would split one contestant into two rows the moment
    // the two disagreed on case — the union is taken case-insensitively, like
    // admin-auth and hint-store do.
    //
    // NEITHER side of this fixture is lowercase by accident. The membership
    // decision compares the quiz store's login against a `seen` set built from
    // the SCORED logins; if the scored spelling here were already lowercase
    // ("ada"), a case-sensitive `seen` would still match the lowercased lookup
    // key and this test would pass against broken code. "Ada" vs "ADA" makes
    // both sides differ, so only a genuinely case-insensitive union passes.
    it("matches logins case-insensitively, so one contestant never becomes two rows", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["ADA", { points: 30, answered: 3, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("Ada", 10, 1)]));

      expect(out.entries).toHaveLength(1);
      // The scored row's own spelling wins — it is the row that already exists.
      expect(out.entries[0].login).toBe("Ada");
      expect(out.entries[0].points).toBe(40);
    });

    it("ranks created rows against scored rows", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["cyd", { points: 99, answered: 9, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("bob", 10, 1)]));

      expect(out.entries.map((e) => [e.login, e.rank])).toEqual([["cyd", 1], ["bob", 2]]);
    });

    it("gives an entry with no quiz activity no quiz module block", async () => {
      // ada has no entry in the aggregate map at all — never answered anything.
      mocks.getQuizTotals.mockResolvedValue(new Map());

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      expect(out.entries[0].modules!["quiz"]).toBeUndefined();
      expect(out.entries[0].points).toBe(30);
    });

    it("reflects the added quiz points in ranking", async () => {
      // Points come first: ada's raw 30 loses to bob's 20 + 15 quiz = 35,
      // once the quiz points are added.
      mocks.getQuizTotals.mockResolvedValue(
        new Map([["bob", { points: 15, answered: 1, lastAt: null }]]),
      );

      const out = await withModuleContributions(
        data([entry("ada", 30, 3), { ...entry("bob", 20, 2), apps: { dvwa: { app: "dvwa", points: 20, maxPoints: 30, patched: 2, total: 3 } } }]),
      );

      expect(out.entries.map((e) => [e.login, e.points])).toEqual([["bob", 35], ["ada", 30]]);
      expect(out.entries.map((e) => e.rank)).toEqual([1, 2]);
    });

    // Regression (C1): rank.ts's completedCount must not drop `patched` the
    // moment ANY module populates `modules` — only when secure-development's
    // OWN block is present does `patched` already have a representative in
    // the sum. On upstash (`capabilities.apps: false`), a row never gets a
    // secure-development block, so answering a quiz question (which DOES
    // stamp a `quiz` block) must not zero out that row's real patch count.
    // ada has more patches AND a quiz answer on top of bob — she must never
    // rank below him.
    // At EQUAL points (points come first), the tiebreak is items
    // completed: ada's 5 patches + 1 answer must count as 6, not 1. If her
    // quiz block made completedCount drop `patched` (no secure-development
    // block on an upstash row), she would lose the tie to bob's 3. Bob is
    // listed first so a dropped `patched` shows as the wrong order, not as
    // source order happening to agree.
    it("keeps a quiz-active row's patches in the tiebreak on an upstash-shaped board", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["ada", { points: 5, answered: 1, lastAt: null }]]));

      const bare = (login: string, points: number, patched: number) => ({
        ...entry(login, points, patched), apps: {},
      });

      const out = await withModuleContributions({
        ...data([bare("bob", 30, 3), bare("ada", 25, 5)]),
        capabilities: { apps: false, teams: false, challenges: false },
      });

      expect(out.entries.map((e) => [e.login, e.points])).toEqual([["ada", 30], ["bob", 30]]);
      expect(out.entries[0].modules!["secure-development"]).toBeUndefined();
      expect(out.entries[0].modules!["quiz"]).toBeDefined();
    });

    // The team's quiz points have one owner: `withTeamQuizPoints` (called by
    // withTeamStandings) adds them one stage later, so adding them here too
    // would count every scorer team's quiz points twice. This stage stamps a
    // team's secure-development chip and must leave its points alone.
    it("adds no quiz points to a source team — withTeamStandings owns that", async () => {
      mocks.getTeamQuizTotalsBatch.mockResolvedValue([{ points: 20, answered: 1, lastAt: "2026-08-01T11:00:00.000Z" }]);

      const teams: TeamStanding[] = [
        { rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada", "cyd"] },
      ];
      const out = await withModuleContributions(data([entry("ada", 30, 3)], teams));

      expect(mocks.getTeamQuizTotalsBatch).not.toHaveBeenCalled();
      expect(out.teams[0].points).toBe(30);
      expect(out.teams[0].modules?.["quiz"]).toBeUndefined();
    });

    it("withTeamQuizPoints adds the team's already-deduped quiz total to team points", async () => {
      // getTeamQuizTotalsBatch owns the union-by-question dedupe logic
      // (proven at the store level in quiz-store.test.ts, where two members
      // sharing the same question collapse to one). This test only checks
      // that the team overlay ADDS whatever that function returns — it is
      // NOT the dedupe proof itself.
      mocks.getTeamQuizTotalsBatch.mockResolvedValue([{ points: 20, answered: 1, lastAt: "2026-08-01T11:00:00.000Z" }]);

      const teams: TeamStanding[] = [
        { rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada", "cyd"] },
      ];
      const out = await withTeamQuizPoints(teams);

      expect(mocks.getTeamQuizTotalsBatch).toHaveBeenCalledWith([["ada", "cyd"]]);
      // 30 (existing, already-deduped secure-dev team points) + 20 (the ONE
      // question's points) — never 40 (which would be double counting the
      // question across both members).
      expect(out[0].points).toBe(50);
      expect(out[0].modules!["quiz"]).toMatchObject({ points: 20, completed: 1 });
    });

    it("does not touch team points when the source has no deduped team data yet (upstash shape)", async () => {
      const teams: TeamStanding[] = [
        { rank: 1, slug: "red", name: "Red", captain: "ada", points: 0, members: ["ada", "cyd"] },
      ];
      const out = await withModuleContributions({
        ...data([entry("ada", 30, 3)], teams),
        capabilities: { apps: true, teams: false, challenges: false },
      });

      expect(mocks.getTeamQuizTotalsBatch).not.toHaveBeenCalled();
      expect(out.teams).toEqual(teams);
    });

    // I4: the per-team form issued its own pipeline per team, so a 25-team
    // event cost 25 Upstash round trips on every render of a page that is
    // dynamic and fetched `no-store`. The overlay must hand the WHOLE board
    // to the batched helper in one call.
    it("asks for every team's quiz total in a single batched call", async () => {
      mocks.getTeamQuizTotalsBatch.mockResolvedValue([
        { points: 20, answered: 1, lastAt: "2026-08-01T11:00:00.000Z" },
        { points: 5, answered: 1, lastAt: "2026-08-01T12:00:00.000Z" },
        { points: 0, answered: 0, lastAt: null },
      ]);

      const teams: TeamStanding[] = [
        { rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada", "cyd"] },
        { rank: 2, slug: "blue", name: "Blue", captain: "bob", points: 20, members: ["bob"] },
        { rank: 3, slug: "grey", name: "Grey", captain: "eve", points: 10, members: ["eve"] },
      ];
      const out = await withTeamQuizPoints(teams);

      expect(mocks.getTeamQuizTotalsBatch).toHaveBeenCalledTimes(1);
      expect(mocks.getTeamQuizTotalsBatch).toHaveBeenCalledWith([["ada", "cyd"], ["bob"], ["eve"]]);
      // Each team's own total landed on its own row (order preserved
      // through the batch's partitioning), and the quiz-less team got none.
      expect(out.map((t) => [t.slug, t.points])).toEqual([["red", 50], ["blue", 25], ["grey", 10]]);
      expect(out.find((t) => t.slug === "grey")!.modules?.["quiz"]).toBeUndefined();
    });

    // I3: the two reads are settled independently. `listQuestions` supplies
    // only the "answered / total" DENOMINATOR — if it fails, the board must
    // keep every contestant's quiz POINTS (and the ranking they drive),
    // never silently zero them and re-rank on wrong totals while /profile
    // still shows the real number.
    it("keeps quiz points and ranking when only the question list fails", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["bob", { points: 15, answered: 2, lastAt: null }]]));
      mocks.listQuestions.mockRejectedValue(new Error("upstash blip"));

      const out = await withModuleContributions(
        data([
          entry("ada", 30, 3),
          { ...entry("bob", 20, 2), apps: { dvwa: { app: "dvwa", points: 20, maxPoints: 30, patched: 2, total: 3 } } },
        ]),
      );

      // bob's 20 + 15 quiz = 35 still beats ada's 30, exactly as it would
      // have with a healthy question list.
      expect(out.entries.map((e) => [e.login, e.points])).toEqual([["bob", 35], ["ada", 30]]);
      const quiz = out.entries[0].modules!["quiz"]!;
      expect(quiz.points).toBe(15);
      // Only the denominator degrades — and it degrades to the clamp, never
      // below the numerator.
      expect(quiz.detail).toEqual({ kind: "quiz", answered: 2, total: 2, points: 15 });
    });

    it("still shows the board when only the totals read fails", async () => {
      mocks.getQuizTotals.mockRejectedValue(new Error("upstash blip"));

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      expect(out.entries[0].points).toBe(30);
      expect(out.entries[0].modules!["quiz"]).toBeUndefined();
      // C4: the totals map is where created rows come from, so a failed read
      // degrades to the quiz-less board — it must never invent rows, and
      // certainly not zero-point ones.
      expect(out.entries.map((e) => e.login)).toEqual(["ada"]);
    });

    // I1's display bug: `deleteQuestion` deliberately leaves banked points
    // and the aggregate `answered` counter alone, so after a delete a login
    // can hold more answers than the question list has entries. The
    // denominator must never render below the numerator ("1 / 0 answered").
    it("never renders a denominator smaller than the numerator after a question is deleted", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["ada", { points: 10, answered: 1, lastAt: null }]]));
      mocks.listQuestions.mockResolvedValue([]); // the only question was deleted

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      const quiz = out.entries[0].modules!["quiz"]!;
      expect(quiz.detail).toEqual({ kind: "quiz", answered: 1, total: 1, points: 10 });
      // Points already banked for the deleted question stay on the board.
      expect(out.entries[0].points).toBe(40);
    });

    it("clamps a team's denominator the same way", async () => {
      mocks.listQuestions.mockResolvedValue([{ id: "q1" }]);
      mocks.getTeamQuizTotalsBatch.mockResolvedValue([{ points: 30, answered: 3, lastAt: null }]);

      const teams: TeamStanding[] = [
        { rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada", "cyd"] },
      ];
      const out = await withTeamQuizPoints(teams);

      expect(out[0].modules!["quiz"]!.detail).toEqual({ kind: "quiz", answered: 3, total: 3, points: 30 });
    });
  });

  describe("with the classic module disabled", () => {
    it("never reads classic data and adds no classic block", async () => {
      const out = await withModuleContributions(data([entry("ada", 30, 3)]));
      expect(out.entries[0].modules!["classic"]).toBeUndefined();
      expect(out.entries[0].points).toBe(30);
      expect(mocks.getClassicTotals).not.toHaveBeenCalled();
      expect(mocks.listChallenges).not.toHaveBeenCalled();
    });
  });

  describe("with the classic module enabled", () => {
    beforeEach(() => {
      mocks.moduleLive.mockImplementation((id: string) => id === "secure-development" || id === "classic");
      mocks.listChallenges.mockResolvedValue([{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
    });

    // The scorer never sees a captured flag, so classic points are NOT already
    // inside `entry.points` — they are ADDED. Attributing them (the verb
    // secure-development uses, because ITS points already are inside
    // `entry.points`) would show the contestant's classic total as zero.
    it("ADDS classic points rather than attributing them", async () => {
      mocks.getClassicTotals.mockResolvedValue(new Map([["alice", { points: 50, solved: 2, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("alice", 100, 3)]));

      expect(out.entries[0].points).toBe(150); // 100 scored + 50 classic
      const classic = out.entries[0].modules!["classic"]!;
      expect(classic).toMatchObject({ points: 50, completed: 2 });
      expect(classic.detail).toEqual({ kind: "classic", solved: 2, total: 3, points: 50 });
      // secure-development's own attribution is untouched by the addition.
      expect(out.entries[0].modules!["secure-development"]).toMatchObject({ points: 100, completed: 3 });
    });

    // Without this, every contestant on a classic-only event is invisible:
    // the source is `emptySource` and carries no rows at all to overlay onto.
    it("creates a row for a login with classic points and no scored entry", async () => {
      mocks.getClassicTotals.mockResolvedValue(new Map([["alice", { points: 50, solved: 2, lastAt: null }]]));

      const out = await withModuleContributions(data([]));

      expect(out.entries.map((e) => e.login)).toContain("alice");
      const alice = out.entries.find((e) => e.login === "alice")!;
      expect(alice.points).toBe(50);
      // Nothing behind this row came from the scorer, so nothing scorer-shaped
      // may be non-zero on it.
      expect(alice).toMatchObject({ patched: 0, failed: 0, total: 0, apps: {}, team: null });
      expect(alice.modules!["classic"]).toMatchObject({ points: 50, completed: 2 });
    });

    // The scorer records the PR author's login, the classic store the
    // session's. Matching them exactly would split one contestant into two
    // rows the moment the two disagreed on case.
    it("unions logins case-insensitively so one contestant is never two rows", async () => {
      mocks.getClassicTotals.mockResolvedValue(new Map([["alice", { points: 50, solved: 2, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("Alice", 0, 0)]));

      expect(out.entries).toHaveLength(1);
      // The scored row's own spelling wins — it is the row that already exists
      // — and it carries the classic points, proving the LOOKUP is
      // case-insensitive too and not just the create-or-not decision.
      expect(out.entries[0].login).toBe("Alice");
      expect(out.entries[0].points).toBe(50);
      expect(out.entries[0].modules!["classic"]).toMatchObject({ points: 50, completed: 2 });
    });

    // The denominator is cosmetic; the points are not. A shared try/catch
    // over the two reads silently deleted everyone's points and re-ranked the
    // board — a bug this kit has already shipped once, on the quiz path.
    it("keeps points when only the challenge list read fails", async () => {
      mocks.getClassicTotals.mockResolvedValue(new Map([["alice", { points: 50, solved: 2, lastAt: null }]]));
      mocks.listChallenges.mockRejectedValue(new Error("upstash blip"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const out = await withModuleContributions(data([entry("alice", 0, 0)]));

        expect(out.entries[0].points).toBe(50);
        // Only the denominator degrades — and it degrades to the clamp, never
        // below its own numerator.
        expect(out.entries[0].modules!["classic"]!.detail).toEqual({
          kind: "classic",
          solved: 2,
          total: 2,
          points: 50,
        });
      } finally {
        err.mockRestore();
      }
    });

    it("still shows the board when only the totals read fails", async () => {
      mocks.getClassicTotals.mockRejectedValue(new Error("upstash blip"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const out = await withModuleContributions(data([entry("ada", 30, 3)]));

        expect(out.entries[0].points).toBe(30);
        expect(out.entries[0].modules!["classic"]).toBeUndefined();
        // The totals map is where created rows come from, so a failed read
        // degrades to the classic-less board — never invented rows.
        expect(out.entries.map((e) => e.login)).toEqual(["ada"]);
      } finally {
        err.mockRestore();
      }
    });

    // `deleteChallenge` deliberately leaves banked points and the aggregate
    // counter alone, so the challenge list can be SHORTER than the solve
    // count. Unclamped this renders "1 / 0 flags".
    it("clamps the denominator below its own numerator", async () => {
      mocks.getClassicTotals.mockResolvedValue(new Map([["alice", { points: 50, solved: 1, lastAt: null }]]));
      mocks.listChallenges.mockResolvedValue([]); // the only challenge was deleted

      const out = await withModuleContributions(data([entry("alice", 0, 0)]));

      const detail = out.entries[0].modules?.classic?.detail;
      if (detail?.kind !== "classic") throw new Error("shape");
      expect(detail.total).toBeGreaterThanOrEqual(detail.solved);
      expect(detail).toEqual({ kind: "classic", solved: 1, total: 1, points: 50 });
      // Points already banked for the deleted challenge stay on the board.
      expect(out.entries[0].points).toBe(50);
    });

    it("gives a login with no solves no classic block", async () => {
      mocks.getClassicTotals.mockResolvedValue(new Map([["ada", { points: 0, solved: 0, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      expect(out.entries[0].modules!["classic"]).toBeUndefined();
      expect(out.entries[0].points).toBe(30);
      // …and a zero-solve login must not become a row of its own either.
      expect(out.entries).toHaveLength(1);
    });

    it("reflects the added classic points in ranking", async () => {
      mocks.getClassicTotals.mockResolvedValue(new Map([["bob", { points: 40, solved: 3, lastAt: null }]]));

      const out = await withModuleContributions(
        data([
          entry("ada", 30, 3),
          { ...entry("bob", 20, 2), apps: { dvwa: { app: "dvwa", points: 20, maxPoints: 30, patched: 2, total: 3 } } },
        ]),
      );

      expect(out.entries.map((e) => [e.login, e.points])).toEqual([["bob", 60], ["ada", 30]]);
      expect(out.entries.map((e) => e.rank)).toEqual([1, 2]);
    });

    // ONE pipeline for the whole board, never one call per team: /leaderboard
    // is dynamic and fetched `no-store`, so a per-team form would bill a
    // 25-team event 25 Upstash round trips on every single page view.
    it("asks for every team's classic total in a single batched call", async () => {
      mocks.getTeamClassicTotalsBatch.mockResolvedValue([
        { points: 20, solved: 1, lastAt: "2026-08-01T11:00:00.000Z" },
        { points: 0, solved: 0, lastAt: null },
      ]);

      const teams: TeamStanding[] = [
        { rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada", "cyd"] },
        { rank: 2, slug: "grey", name: "Grey", captain: "eve", points: 10, members: ["eve"] },
      ];
      const out = await withTeamClassicPoints(teams);

      expect(mocks.getTeamClassicTotalsBatch).toHaveBeenCalledTimes(1);
      expect(mocks.getTeamClassicTotalsBatch).toHaveBeenCalledWith([["ada", "cyd"], ["eve"]]);
      // 30 (already-deduped secure-dev team points) + 20 (the ONE challenge's
      // points) — never 40, which would double count it across both members.
      expect(out.map((t) => [t.slug, t.points])).toEqual([["red", 50], ["grey", 10]]);
      expect(out[0].modules!["classic"]).toMatchObject({ points: 20, completed: 1 });
      // A team with no solves gets no block rather than an empty one.
      expect(out.find((t) => t.slug === "grey")!.modules?.["classic"]).toBeUndefined();
    });
  });

  // Both app-side modules on at once. The two are added independently and must
  // land on ONE row per contestant — not one row per module, and not one
  // module's points silently replacing the other's.
  describe("with both quiz and classic enabled", () => {
    beforeEach(() => {
      mocks.moduleLive.mockImplementation((id: string) => id !== "secure-development");
      mocks.listQuestions.mockResolvedValue([{ id: "q1" }, { id: "q2" }]);
      mocks.listChallenges.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    });

    it("creates ONE row carrying both modules' blocks and both modules' points", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["alice", { points: 15, answered: 1, lastAt: null }]]));
      // Different casing from the quiz store's spelling of the same login.
      mocks.getClassicTotals.mockResolvedValue(new Map([["Alice", { points: 50, solved: 2, lastAt: null }]]));

      const out = await withModuleContributions(data([]));

      expect(out.entries).toHaveLength(1);
      expect(out.entries[0].points).toBe(65);
      expect(out.entries[0].modules!["quiz"]).toMatchObject({ points: 15, completed: 1 });
      expect(out.entries[0].modules!["classic"]).toMatchObject({ points: 50, completed: 2 });
    });

    it("adds both modules' points to one scored row", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["ada", { points: 15, answered: 1, lastAt: null }]]));
      mocks.getClassicTotals.mockResolvedValue(new Map([["ada", { points: 50, solved: 2, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("ada", 10, 1)]));

      expect(out.entries).toHaveLength(1);
      expect(out.entries[0].points).toBe(75); // 10 + 15 + 50
    });

    it("adds both modules' points to one team row", async () => {
      mocks.getTeamQuizTotalsBatch.mockResolvedValue([{ points: 15, answered: 1, lastAt: null }]);
      mocks.getTeamClassicTotalsBatch.mockResolvedValue([{ points: 50, solved: 2, lastAt: null }]);

      const teams: TeamStanding[] = [
        { rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada"] },
      ];
      const out = await withTeamClassicPoints(await withTeamQuizPoints(teams));

      expect(out[0].points).toBe(95); // 30 + 15 + 50
      expect(out[0].modules!["quiz"]).toMatchObject({ points: 15 });
      expect(out[0].modules!["classic"]).toMatchObject({ points: 50 });
    });

    // One module's outage must cost only its own points — never the other's.
    it("keeps quiz points when the classic totals read fails", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["ada", { points: 15, answered: 1, lastAt: null }]]));
      mocks.getClassicTotals.mockRejectedValue(new Error("upstash blip"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const out = await withModuleContributions(data([entry("ada", 10, 1)]));
        expect(out.entries[0].points).toBe(25);
        expect(out.entries[0].modules!["quiz"]).toMatchObject({ points: 15 });
        expect(out.entries[0].modules!["classic"]).toBeUndefined();
      } finally {
        err.mockRestore();
      }
    });

    // ai's counterpart to the test above, for the THIRD module sharing this
    // describe's `id !== "secure-development"` enablement mock (quiz, classic
    // AND ai are all live here). Each module's read pair is settled
    // independently — see the doc comment on `aiReads` — so a failed
    // `getAiTotals` must leave quiz's and classic's points, and the order they
    // drive, byte-for-byte identical to a run where ai's read never failed at
    // all. Computing both runs and comparing them (rather than hardcoding
    // expected numbers) is what catches a mutant that clears quiz+classic
    // totals inside the ai failure branch: hardcoded expectations on the
    // failure run alone would still need to be right, but a same-shape mutant
    // that zeroed all three consistently could still satisfy them by
    // coincidence, whereas it cannot make the failure run equal the untouched
    // green run.
    it("keeps quiz and classic points and ordering identical whether the ai totals read succeeds or fails", async () => {
      mocks.getQuizTotals.mockResolvedValue(new Map([["ada", { points: 15, answered: 1, lastAt: null }]]));
      mocks.getClassicTotals.mockResolvedValue(new Map([["bob", { points: 40, solved: 2, lastAt: null }]]));
      const fixture = () => data([entry("ada", 10, 1), entry("bob", 5, 1)]);

      const green = await withModuleContributions(fixture());

      mocks.getAiTotals.mockRejectedValue(new Error("upstash blip"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      let degraded: Awaited<ReturnType<typeof withModuleContributions>>;
      try {
        degraded = await withModuleContributions(fixture());
      } finally {
        err.mockRestore();
      }

      const shape = (out: typeof green) =>
        out.entries.map((e) => [e.login, e.points, e.rank, e.modules?.quiz, e.modules?.classic]);
      expect(shape(degraded)).toEqual(shape(green));
      // Positive pin so two vacuously-equal (all-zeroed) runs can't pass this
      // by coincidence: the numbers themselves must be the real ones.
      expect(degraded.entries.find((e) => e.login === "ada")!.modules!["quiz"]).toMatchObject({ points: 15 });
      expect(degraded.entries.find((e) => e.login === "bob")!.modules!["classic"]).toMatchObject({ points: 40 });
      expect(degraded.entries.every((e) => e.modules?.ai === undefined)).toBe(true);
    });
  });

  // Regression gate specific to the ai module: with it DISABLED, the
  // leaderboard must behave exactly as with no ai module present — no ai
  // reads, no ai block, no ranking change driven by ai data. Mirrors the
  // quiz/classic disabled pairs above.
  describe("with the ai module disabled", () => {
    it("never reads ai data and adds no ai block", async () => {
      const out = await withModuleContributions(data([entry("ada", 30, 3)]));
      expect(out.entries[0].modules!["ai"]).toBeUndefined();
      expect(out.entries[0].points).toBe(30);
      expect(mocks.getAiTotals).not.toHaveBeenCalled();
      expect(mocks.listAiChallenges).not.toHaveBeenCalled();
    });

    it("creates no rows — a disabled module contributes no points to create one from", async () => {
      const out = await withModuleContributions(data([]));
      expect(out.entries).toEqual([]);
      expect(mocks.getAiTotals).not.toHaveBeenCalled();
    });
  });

  describe("with the ai module enabled", () => {
    beforeEach(() => {
      mocks.moduleLive.mockImplementation((id: string) => id === "secure-development" || id === "ai");
      mocks.listAiChallenges.mockResolvedValue([{ id: "a1" }, { id: "a2" }, { id: "a3" }]);
    });

    // ai is app-side like quiz/classic: the scorer never sees a prompt-
    // injection solve, so its points are NOT already inside `entry.points` —
    // they are ADDED, never attributed.
    it("adds ai points to the entry's total and renders an ai module with completed = solved count", async () => {
      mocks.getAiTotals.mockResolvedValue(new Map([["ada", { points: 20, solved: 2, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      // ADDED, not attributed: 30 (secure-dev, unchanged) + 20 (ai) = 50.
      expect(out.entries[0].points).toBe(50);
      const ai = out.entries[0].modules!["ai"]!;
      expect(ai).toMatchObject({ points: 20, completed: 2 });
      expect(ai.detail).toEqual({ kind: "ai", solved: 2, total: 3, points: 20 });
      // secure-development's own attribution is untouched by the addition.
      expect(out.entries[0].modules!["secure-development"]).toMatchObject({ points: 30, completed: 3 });
    });

    // F2: `completable`'s `+ aiTotalChallenges` term (module-contributions.ts)
    // was unpinned — dropping it left the whole suite green. This describe's
    // own `beforeEach` stubs `listAiChallenges` to a 3-item catalogue and
    // disables quiz/classic, so the board's completable denominator here is
    // exactly the secure-development catalogue plus those 3 ai challenges.
    it("includes the ai catalogue size in the board's completable denominator", async () => {
      const out = await withModuleContributions(data([entry("ada", 30, 3)]));
      expect(out.completable).toBe(enabledTotalChallenges + 3);
    });

    // Beside the positive twin above: a corrupted store row must never let
    // grading-shaped material reach the serialized leaderboard payload. ai
    // fields are picked one at a time by `aiModule`, so an extra field on the
    // source record has no path into ModuleProgress — this test pins that.
    it("never leaks poisoned fields on an ai record into the serialized board", async () => {
      const poisoned = {
        points: 20,
        solved: 2,
        lastAt: null,
        flag: "CTF{leak}",
        signingKey: "aik_super_secret",
        launchToken: "-----BEGIN PRIVATE KEY-----",
      };
      mocks.getAiTotals.mockResolvedValue(new Map([["ada", poisoned]]) as unknown as Map<string, AiTotal>);

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      // Positive twin: the block still rendered off the same fixture's real
      // fields.
      expect(out.entries[0].modules!["ai"]).toMatchObject({ points: 20, completed: 2 });

      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("CTF{leak}");
      expect(serialized).not.toContain("aik_super_secret");
      expect(serialized).not.toContain("PRIVATE KEY");
    });

    // F4: the poison test above covers `getAiTotals`; `listAiChallenges`
    // records need the same pin. Only `.length` is read off them today (the
    // denominator), so nothing on the record has a path into the payload yet
    // — but this catches the day someone starts rendering the catalogue
    // itself (title, description, …) without re-checking this discipline.
    it("never leaks poisoned fields on a listAiChallenges record into the serialized board", async () => {
      mocks.getAiTotals.mockResolvedValue(new Map([["ada", { points: 20, solved: 2, lastAt: null }]]));
      const poisonedChallenge = {
        id: "a1",
        title: "Prompt Leak",
        category: "prompt-injection",
        description: "Get the model to leak its instructions.",
        points: 20,
        order: 1,
        mode: "flag",
        urlTemplate: "https://example.test/{token}",
        flag: "CTF{leak}",
        signingKey: "aik_super_secret",
        launchToken: "-----BEGIN PRIVATE KEY-----",
      };
      mocks.listAiChallenges.mockResolvedValue([poisonedChallenge] as unknown as AiChallenge[]);

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      // Positive twin: the block still rendered off the same fixture — the
      // denominator (1 listed challenge) clamps up to the real solved count.
      expect(out.entries[0].modules!["ai"]).toMatchObject({ points: 20, completed: 2 });
      expect(out.entries[0].modules!["ai"]!.detail).toEqual({ kind: "ai", solved: 2, total: 2, points: 20 });

      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("CTF{leak}");
      expect(serialized).not.toContain("aik_super_secret");
      expect(serialized).not.toContain("PRIVATE KEY");
    });

    // The board's login set is the UNION of the source's logins and the
    // logins holding module points — mirrors quiz's created-row test.
    it("creates a row for a contestant with ai points and no scored submission", async () => {
      mocks.getAiTotals.mockResolvedValue(new Map([["cyd", { points: 30, solved: 3, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      const cyd = out.entries.find((e) => e.login === "cyd")!;
      expect(cyd.points).toBe(30);
      expect(cyd).toMatchObject({ patched: 0, failed: 0, total: 0, apps: {}, team: null });
      expect(cyd.modules!["secure-development"]).toBeUndefined();
      expect(cyd.modules!["ai"]).toMatchObject({ points: 30, completed: 3 });
    });

    it("matches logins case-insensitively, so one contestant never becomes two rows", async () => {
      mocks.getAiTotals.mockResolvedValue(new Map([["ADA", { points: 30, solved: 3, lastAt: null }]]));

      const out = await withModuleContributions(data([entry("Ada", 10, 1)]));

      expect(out.entries).toHaveLength(1);
      expect(out.entries[0].login).toBe("Ada");
      expect(out.entries[0].points).toBe(40);
    });

    it("gives an entry with no ai activity no ai module block", async () => {
      mocks.getAiTotals.mockResolvedValue(new Map());

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      expect(out.entries[0].modules!["ai"]).toBeUndefined();
      expect(out.entries[0].points).toBe(30);
    });

    // `deleteAiChallenge`-shaped scenario: a deleted challenge can't push
    // solved > total. Mirrors classic's clamp test.
    it("clamps the denominator below its own numerator", async () => {
      mocks.getAiTotals.mockResolvedValue(new Map([["ada", { points: 10, solved: 3, lastAt: null }]]));
      mocks.listAiChallenges.mockResolvedValue([{ id: "a1" }]); // challenges were deleted

      const out = await withModuleContributions(data([entry("ada", 30, 3)]));

      const detail = out.entries[0].modules?.ai?.detail;
      if (detail?.kind !== "ai") throw new Error("shape");
      expect(detail.total).toBeGreaterThanOrEqual(detail.solved);
      expect(detail).toEqual({ kind: "ai", solved: 3, total: 3, points: 10 });
    });

    // I3's counterpart for ai: the two reads settle independently. A failed
    // `listAiChallenges` must degrade only the denominator (clamped), never
    // the points or the ranking they drive. F5: mirrors quiz's "keeps quiz
    // points and ranking when only the question list fails" with a SECOND
    // entry, so ranking is actually exercised rather than asserted by name
    // alone against a single-row fixture.
    it("keeps ai points and ranking when only the challenge list fails", async () => {
      mocks.getAiTotals.mockResolvedValue(new Map([["bob", { points: 15, solved: 2, lastAt: null }]]));
      mocks.listAiChallenges.mockRejectedValue(new Error("upstash blip"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const out = await withModuleContributions(
          data([
            entry("ada", 30, 3),
            { ...entry("bob", 20, 2), apps: { dvwa: { app: "dvwa", points: 20, maxPoints: 30, patched: 2, total: 3 } } },
          ]),
        );

        // bob's 20 + 15 ai = 35 still beats ada's 30, exactly as it would
        // have with a healthy challenge list.
        expect(out.entries.map((e) => [e.login, e.points])).toEqual([["bob", 35], ["ada", 30]]);
        const ai = out.entries[0].modules!["ai"]!;
        expect(ai.points).toBe(15);
        // Only the denominator degrades — and it degrades to the clamp, never
        // below the numerator.
        expect(ai.detail).toEqual({ kind: "ai", solved: 2, total: 2, points: 15 });
      } finally {
        err.mockRestore();
      }
    });

    it("still shows the board when only the totals read fails", async () => {
      mocks.getAiTotals.mockRejectedValue(new Error("upstash blip"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const out = await withModuleContributions(data([entry("ada", 30, 3)]));
        expect(out.entries[0].points).toBe(30);
        expect(out.entries[0].modules!["ai"]).toBeUndefined();
        expect(out.entries.map((e) => e.login)).toEqual(["ada"]);
      } finally {
        err.mockRestore();
      }
    });

    it("asks for every team's ai total in a single batched call", async () => {
      mocks.getTeamAiTotalsBatch.mockResolvedValue([
        { points: 20, solved: 1, lastAt: "2026-08-01T11:00:00.000Z" },
        { points: 0, solved: 0, lastAt: null },
      ]);

      const teams: TeamStanding[] = [
        { rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada", "cyd"] },
        { rank: 2, slug: "grey", name: "Grey", captain: "eve", points: 10, members: ["eve"] },
      ];
      const out = await withTeamAiPoints(teams);

      expect(mocks.getTeamAiTotalsBatch).toHaveBeenCalledTimes(1);
      expect(mocks.getTeamAiTotalsBatch).toHaveBeenCalledWith([["ada", "cyd"], ["eve"]]);
      expect(out.map((t) => [t.slug, t.points])).toEqual([["red", 50], ["grey", 10]]);
      expect(out[0].modules!["ai"]).toMatchObject({ points: 20, completed: 1 });
      expect(out.find((t) => t.slug === "grey")!.modules?.["ai"]).toBeUndefined();
    });
  });
});

// Every degrade path above logs; none of them may log the caught value. A
// driver-decorated error carries the request in `command`/`cause`, so each
// site hands `console.error` the label only.
describe("module-contributions log redaction (#500)", () => {
  const teams: TeamStanding[] = [{ rank: 1, slug: "red", name: "Red", captain: "ada", points: 30, members: ["ada"] }];

  function failEveryRead(): void {
    mocks.moduleLive.mockImplementation(() => true);
    for (const fn of [
      mocks.getQuizTotals,
      mocks.listQuestions,
      mocks.getTeamQuizTotalsBatch,
      mocks.getClassicTotals,
      mocks.listChallenges,
      mocks.getTeamClassicTotalsBatch,
      mocks.getAiTotals,
      mocks.listAiChallenges,
      mocks.getTeamAiTotalsBatch,
    ]) {
      fn.mockReset();
      fn.mockRejectedValue(decoratedError());
    }
  }

  it("withModuleContributions logs the label at every individual degrade", async () => {
    failEveryRead();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withModuleContributions(data([entry("ada", 30, 3)], teams));
      // Six individual reads, each its own line. (The three team batches
      // are read by withTeam*Points below, not here.)
      expect(consoleError.mock.calls.length).toBeGreaterThanOrEqual(6);
      expectLabelOnly(consoleError);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    ["withTeamQuizPoints", withTeamQuizPoints],
    ["withTeamClassicPoints", withTeamClassicPoints],
    ["withTeamAiPoints", withTeamAiPoints],
  ])("%s logs the label, not the error", async (_name, fold) => {
    failEveryRead();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await fold(teams)).toBe(teams);
      expectLabelOnly(consoleError);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("the denominator-only degrade in a team fold logs the label too", async () => {
    mocks.moduleLive.mockImplementation(() => true);
    mocks.listQuestions.mockRejectedValue(decoratedError());
    mocks.listChallenges.mockRejectedValue(decoratedError());
    mocks.listAiChallenges.mockRejectedValue(decoratedError());
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withTeamQuizPoints(teams);
      await withTeamClassicPoints(teams);
      await withTeamAiPoints(teams);
      expect(consoleError).toHaveBeenCalledTimes(3);
      expectLabelOnly(consoleError);
    } finally {
      consoleError.mockRestore();
    }
  });
});
