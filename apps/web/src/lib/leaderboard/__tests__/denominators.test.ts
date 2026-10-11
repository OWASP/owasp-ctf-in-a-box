// The denominator rule, and the thing it exists to prevent: two surfaces
// disagreeing about the same contestant's same module.
//
// This has been filed three times — #330 (the profile row itself), #343 (the
// profile's own footer, which the fix for #330 left behind), and #348 (the
// leaderboard team row, which could not reach the rule at all because it lived
// in `profile/module-blocks.ts`). Each time the numbers looked like this:
//
//     /leaderboard → AI   5 / 5 cleared     870 pts
//     /profile     → AI   5 / 7 cleared     870 / 1,520 pts
//
// The board says finished; the profile says five of seven. So the last
// describe here is the real regression test: it drives BOTH forms from ONE
// fixture and asserts they land on the same denominator. A future surface that
// invents its own count fails here rather than becoming the fourth filing.
import { describe, expect, it } from "vitest";
import { atLeast, unionDenominators, unionTotal, classicReachableDenominator, type Story } from "../denominators";

// Five live items worth 100 each. The viewer solved three of them, plus two an
// organizer has since deleted — so two live items are still open, and two
// banked solves have no live challenge behind them. The union is 7 / 700.
const LIVE = [1, 2, 3, 4, 5].map((n) => ({ id: `live-${n}`, points: 100 }));
const SOLVED_RECORDS = {
  "live-1": { points: 100 },
  "live-2": { points: 100 },
  "live-3": { points: 100 },
  "deleted-1": { points: 100 },
  "deleted-2": { points: 100 },
};
const SOLVED_IDS = Object.keys(SOLVED_RECORDS);
const LIVE_IDS = new Set(LIVE.map((i) => i.id));

describe("unionTotal", () => {
  it("adds solved items whose challenge is gone to the live count", () => {
    expect(unionTotal(LIVE_IDS, SOLVED_IDS)).toBe(7);
  });

  it("counts a fully live solve set as just the catalogue", () => {
    expect(unionTotal(LIVE_IDS, ["live-1", "live-2"])).toBe(5);
  });

  it("never double-counts a live item that was also solved", () => {
    // The failure a naive `live + solved` would produce: 5 + 5 = 10.
    expect(unionTotal(LIVE_IDS, SOLVED_IDS)).toBeLessThan(LIVE_IDS.size + SOLVED_IDS.length);
  });

  it("falls back to the solve count when the catalogue read FAILED", () => {
    // An empty catalogue here means the list read failed — the leaderboard
    // degrades that to a missing denominator on purpose. Treating every solve
    // as an orphan would report 5 / 5 by a different accident.
    expect(unionTotal(new Set(), SOLVED_IDS)).toBe(5);
  });

  it("is zero for a contestant who has solved nothing on an empty board", () => {
    expect(unionTotal(new Set(), [])).toBe(0);
  });
});

describe("atLeast", () => {
  it("keeps a denominator from falling under its own numerator", () => {
    // "8 / 0 patched" and "1 / 0 flags" are the bugs this exists for.
    expect(atLeast(0, 8)).toBe(8);
    expect(atLeast(38, 6)).toBe(38);
  });

  it("is NOT the union, and the difference is the whole point", () => {
    // max(5, 5) = 5 where the truth is 7. A clamp stops a ratio exceeding one;
    // it cannot discover an item missing from the catalogue, so it reports a
    // module as finished that still has two challenges open.
    expect(atLeast(LIVE_IDS.size, SOLVED_IDS.length)).toBe(5);
    expect(unionTotal(LIVE_IDS, SOLVED_IDS)).toBe(7);
  });
});

describe("unionDenominators", () => {
  it("counts the union and values gone items at what the solve banked", () => {
    expect(unionDenominators(LIVE, SOLVED_RECORDS)).toEqual({ total: 7, max: 700 });
  });

  it("leaves an untouched catalogue alone", () => {
    expect(unionDenominators(LIVE, { "live-1": { points: 100 } })).toEqual({ total: 5, max: 500 });
  });

  it("treats a missing or unparseable price as zero rather than NaN", () => {
    // One bad record must cost its own points, never the whole ceiling.
    expect(unionDenominators([{ id: "live-1" }], { "gone-1": {} })).toEqual({ total: 2, max: 0 });
  });
});

describe("the board and the profile agree", () => {
  it("reaches the same denominator from ids as from solve records (issue #348)", () => {
    // The leaderboard has ids (its fold dedupes members' solves by id); the
    // profile has the records themselves. Different inputs, one rule — and if
    // they ever diverge again, this is the line that says so.
    const fromIds = unionTotal(LIVE_IDS, SOLVED_IDS);
    const fromRecords = unionDenominators(LIVE, SOLVED_RECORDS).total;
    expect(fromIds).toBe(fromRecords);
    expect(fromIds).toBe(7);
  });

  it("agrees on an untouched catalogue too, where the bug was invisible", () => {
    // Both read 5 here, which is why the defect survived three releases: it
    // only appears once an organizer deletes something a contestant solved.
    const solved = { "live-1": { points: 100 }, "live-2": { points: 100 } };
    expect(unionTotal(LIVE_IDS, Object.keys(solved))).toBe(unionDenominators(LIVE, solved).total);
  });
});

// #570: Story-lock reachable denominator tests
describe("classicReachableDenominator", () => {
  const story: Story = {
    id: "story-1",
    title: "Operation CTF",
    intro: "A story",
    steps: ["step-1", "step-2", "step-3"],
  };

  const challenges = [
    { id: "step-1", points: 50 },
    { id: "step-2", points: 100 },
    { id: "step-3", points: 150 },
    { id: "standalone", points: 75 },
  ];

  const solvedRecords = {
    "step-1": { points: 50 },
    "step-2": { points: 100 },
    "standalone": { points: 75 },
  };

  it("step 1 is always reachable; later steps locked until prereq solved", () => {
    // Team solved nothing: only step-1 reachable
    const teamSolved = new Set<string>();
    const result = classicReachableDenominator(challenges, [story], teamSolved, {});
    expect(result.total).toBe(2); // step-1 + standalone
    expect(result.max).toBe(125); // 50 + 75
    expect(result.locked).toBe(2); // step-2, step-3 locked
  });

  it("step 2 unlocks after step 1 is solved", () => {
    const teamSolved = new Set(["step-1"]);
    const result = classicReachableDenominator(challenges, [story], teamSolved, {});
    expect(result.total).toBe(3); // step-1, step-2, standalone
    expect(result.max).toBe(225); // 50 + 100 + 75
    expect(result.locked).toBe(1); // step-3 locked
  });

  it("step 3 unlocks after step 2 is solved", () => {
    const teamSolved = new Set(["step-1", "step-2"]);
    const result = classicReachableDenominator(challenges, [story], teamSolved, {});
    expect(result.total).toBe(4); // step-1, step-2, step-3, standalone
    expect(result.max).toBe(375); // 50 + 100 + 150 + 75
    expect(result.locked).toBe(0);
  });

  it("solved-but-deleted steps are unioned (counted as reachable)", () => {
    // step-4 was solved but deleted from catalogue
    const challengesWithDeleted = [...challenges];
    const teamSolved = new Set(["step-1", "step-4"]);
    const solvedWithDeleted = { ...solvedRecords, "step-4": { points: 200 } };
    const result = classicReachableDenominator(
      challengesWithDeleted,
      [story],
      teamSolved,
      solvedWithDeleted,
    );
    // Reachable live: step-1 (reachable), step-2 (unlocked by step-1), standalone = 3
    // step-3 stays locked because its prereq (step-2) is NOT in teamSolved
    // Solved-but-deleted: step-4 (1)
    // Total: 4
    expect(result.total).toBe(4);
    expect(result.max).toBe(425); // 50 + 100 + 75 + 200
    expect(result.locked).toBe(1); // step-3 locked
  });

  it("teamless contestant (empty solved) sees only step 1 of each story", () => {
    const teamSolved = new Set<string>();
    const result = classicReachableDenominator(challenges, [story], teamSolved, {});
    expect(result.total).toBe(2); // step-1 + standalone
    expect(result.locked).toBe(2);
  });

  it("multiple stories: each story's step 1 is reachable", () => {
    const story2: Story = { ...story, id: "story-2", steps: ["step-a", "step-b"] };
    const challenges2 = [...challenges, { id: "step-a", points: 60 }, { id: "step-b", points: 80 }];
    const teamSolved = new Set<string>();
    const result = classicReachableDenominator(challenges2, [story, story2], teamSolved, {});
    // story-1 step-1 reachable, story-1 step-2 locked, story-1 step-3 locked
    // story-2 step-a reachable, story-2 step-b locked
    // standalone reachable
    // Total reachable: 3 (step-1, step-a, standalone)
    // Locked: 3 (step-2, step-3, step-b)
    expect(result.total).toBe(3);
    expect(result.locked).toBe(3);
  });

  it("locked count is only for live challenges, not deleted ones", () => {
    const teamSolved = new Set<string>();
    const result = classicReachableDenominator(challenges, [story], teamSolved, {
      "deleted-step": { points: 100 },
    });
    // Deleted steps don't count as locked
    expect(result.locked).toBe(2);
  });

  it("locked step already solved by team is treated as reachable (banked points not hidden)", () => {
    // Team has step-2 in teamSolved but not step-1 (teammate left)
    // Since step-2 is in teamSolved, isLocked returns false (solved steps are never locked)
    // This also unlocks step-3 because its prereq (step-2) is in teamSolved
    const teamSolved = new Set(["step-2"]); // they have step-2 but not step-1
    const result = classicReachableDenominator(challenges, [story], teamSolved, {
      "step-2": { points: 100 },
    });
    // step-1 (always reachable), step-2 (in teamSolved), step-3 (prereq step-2 in teamSolved), standalone = 4
    expect(result.total).toBe(4);
    expect(result.max).toBe(375);
  });

  it("challenges not in any story are always reachable", () => {
    const teamSolved = new Set<string>();
    const result = classicReachableDenominator(challenges, [story], teamSolved, {});
    // standalone is not in a story
    expect(result.total).toBe(2);
    expect(result.max).toBe(125);
  });

  it("empty stories list means all challenges reachable", () => {
    const teamSolved = new Set<string>();
    const result = classicReachableDenominator(challenges, [], teamSolved, {});
    expect(result.total).toBe(4);
    expect(result.max).toBe(375);
    expect(result.locked).toBe(0);
  });
});
