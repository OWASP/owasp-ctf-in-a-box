// #570: the story-lock reachable denominator has ONE owner
// (`classicReachableDenominator` in leaderboard/denominators.ts) and every
// surface that shows classic progress has to read their answer out of it —
// the profile through its own `moduleRow`/`buildModuleProgress`, the board's
// team rows through `withTeamStandings` → `withTeamClassicPoints`, and the
// board's contestant rows through `withModuleContributions`. This pins that
// the locked-step count reaches ALL of them, and that they divide by the same
// number: a surface that quietly fell back to the live catalogue (or to the
// old union) would disagree with the others about the same contestant.
//
// Own file because `vi.mock` is hoisted per file — same split the sibling
// classic-only/quiz-only suites use.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardData } from "../types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enabled-modules", async () =>
  (await import("@/test/enabled-modules-mock")).mockEnabledModules(["classic"]),
);

const mocks = vi.hoisted(() => ({
  listTeams: vi.fn(),
  getClassicTotals: vi.fn(),
  getTeamClassicTotalsBatch: vi.fn(),
  listChallenges: vi.fn(),
  listStories: vi.fn(),
}));

vi.mock("@/lib/team-store", () => ({ listTeams: mocks.listTeams }));
vi.mock("@/lib/classic-store", () => ({
  getClassicTotals: mocks.getClassicTotals,
  getTeamClassicTotalsBatch: mocks.getTeamClassicTotalsBatch,
  listChallenges: mocks.listChallenges,
  listStories: mocks.listStories,
}));

import { withModuleContributions } from "../module-contributions";
import { withTeamStandings } from "../team-standings";
import { classicReachableDenominator, type Story } from "../denominators";
import {
  buildModuleProgress,
  moduleRow,
  type ProfileModuleInput,
} from "@/app/(site)/profile/module-blocks";

// One three-step story: step one is always reachable, step two unlocks after
// it, step three after step two. The team has solved only step one.
const CHALLENGES = [
  { id: "step-1", title: "Step One", category: "Web", description: "", points: 10, order: 0 },
  { id: "step-2", title: "Step Two", category: "Web", description: "", points: 50, order: 1 },
  { id: "step-3", title: "Step Three", category: "Web", description: "", points: 90, order: 2 },
];
const STORY: Story = { id: "s1", title: "Operation", intro: "", steps: ["step-1", "step-2", "step-3"] };

const empty = (): LeaderboardData => ({
  entries: [],
  teams: [],
  generatedAt: "2026-08-01T00:00:00.000Z",
  capabilities: { apps: false, teams: false, challenges: false },
});

/** What the team fold hands `withTeamClassicPoints` for this solve set. */
const teamTotal = {
  points: 10,
  solved: 1,
  lastAt: null,
  itemIds: ["step-1"],
  itemPoints: { "step-1": 10 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClassicTotals.mockResolvedValue(new Map());
  mocks.listChallenges.mockResolvedValue(CHALLENGES);
  mocks.listStories.mockResolvedValue([STORY]);
  mocks.listTeams.mockResolvedValue([{ slug: "red", name: "Red", members: ["ada"] }]);
  mocks.getTeamClassicTotalsBatch.mockResolvedValue([teamTotal]);
});

describe("the locked count reaches the profile and the leaderboard (#570)", () => {
  it("carries locked and the reachable denominator to every detail block", async () => {
    const board = await withModuleContributions(empty()).then(withTeamStandings);
    const teamDetail = board.teams[0].modules!.classic!.detail;
    if (teamDetail.kind !== "classic") throw new Error("classic block missing on the team row");
    // The board: step three is locked for this team, so it is neither counted
    // nor offered — 1 solved, 2 reachable, 1 locked.
    expect(teamDetail.locked).toBe(1);
    expect(teamDetail.total).toBe(2);
    expect(teamDetail.solved).toBe(1);

    // The profile builds its half from the viewer's own reads (a solve record
    // per step, and the team's solved-id set) through the same helper.
    const reachable = classicReachableDenominator(
      CHALLENGES,
      [STORY],
      new Set(["step-1"]),
      { "step-1": { points: 10 } },
    );
    const input = {
      profile: null,
      appsRecord: {},
      challengeCount: 0,
      enabledMaxPoints: 0,
      secureDev: false,
      classic: {
        total: { points: 10, solved: 1, lastAt: null },
        challenges: CHALLENGES,
        maxPoints: reachable.max,
        viewer: { solved: { "step-1": { points: 10, at: "t" } }, attempts: {} },
        locked: new Set(["step-3"]),
        reachableTotal: reachable.total,
        lockedCount: reachable.locked,
      },
    } as unknown as ProfileModuleInput;

    const blocks = buildModuleProgress(input);
    const profileDetail = blocks.classic!.detail;
    if (profileDetail.kind !== "classic") throw new Error("classic block missing on the profile");
    expect(profileDetail.locked).toBe(1);
    expect(profileDetail.total).toBe(2);

    // Neither surface may fall back to the live catalogue (3) or to the
    // union (3): they divide by the same reachable number, and show the same
    // locked count beside it.
    const row = moduleRow(blocks.classic!, input);
    expect(row.total).toBe(teamDetail.total);
    expect(row.locked).toBe(teamDetail.locked);
    expect(row.total).toBe(profileDetail.total);
  });

  // A contestant row divides by the whole catalogue unless its reachability
  // input feeds it, and then the same viewer reads "1 / 3" on the board while
  // /profile reads "1 / 2". Its solves fold through the same team roster the
  // team row uses, so both rows and the profile agree — asserted off the real
  // pipeline rather than a hand-plugged fixture, because the wiring is what
  // breaks.
  it("gives a contestant row the same reachable denominator as the team row", async () => {
    mocks.getClassicTotals.mockResolvedValue(new Map([["ada", { points: 10, solved: 1, lastAt: null }]]));

    const board = await withModuleContributions(empty()).then(withTeamStandings);

    const teamDetail = board.teams[0].modules!.classic!.detail;
    const contestant = board.entries.find((e) => e.login === "ada");
    const contestantDetail = contestant?.modules?.classic?.detail;
    if (teamDetail.kind !== "classic" || contestantDetail?.kind !== "classic") {
      throw new Error("classic block missing from the pipeline's rows");
    }

    expect(contestantDetail).toEqual(teamDetail);
    expect(contestantDetail.total).toBe(2);
    expect(contestantDetail.locked).toBe(1);
  });
});
