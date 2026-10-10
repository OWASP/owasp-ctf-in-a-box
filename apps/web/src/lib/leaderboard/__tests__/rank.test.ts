// Unit tests for the standing comparator (#522). Order of precedence:
//   1. total points desc
//   2. items completed across modules desc (with no module data: patched)
//   3. activity time asc (earlier = reached the score first = higher rank)
// Entries without an activity time sort after those with one.

import { describe, expect, it } from "vitest";
import { compareTeamStanding, rankByStanding } from "../rank";
import type { LeaderboardEntry, TeamStanding } from "../types";

function entry(
  login: string,
  { patched = 0, points = 0, lastSolveAt = null as string | null } = {},
): LeaderboardEntry {
  return {
    rank: 0,
    login,
    team: null,
    points,
    patched,
    failed: 0,
    total: 0,
    apps: {},
    updatedAt: null,
    lastSolveAt,
  };
}

describe("rankByStanding", () => {
  it("orders by points first", () => {
    const ranked = rankByStanding([
      entry("low", { patched: 2, points: 90 }),
      entry("high", { patched: 2, points: 500 }),
    ]);
    expect(ranked.map((e) => [e.login, e.rank])).toEqual([
      ["high", 1],
      ["low", 2],
    ]);
  });

  it("ranks more points above more items, whatever the item deficit", () => {
    // The #522 change: the old breadth-first rule put `grinder` first.
    const ranked = rankByStanding([
      entry("grinder", { patched: 9, points: 20 }),
      entry("scorer", { patched: 1, points: 9999 }),
    ]);
    expect(ranked.map((e) => e.login)).toEqual(["scorer", "grinder"]);
  });

  it("breaks points ties on items completed", () => {
    const ranked = rankByStanding([
      entry("fewer", { patched: 2, points: 120 }),
      entry("more", { patched: 5, points: 120 }),
    ]);
    expect(ranked.map((e) => e.login)).toEqual(["more", "fewer"]);
  });

  it("breaks points+items ties by earlier lastSolveAt", () => {
    const ranked = rankByStanding([
      entry("later", { patched: 5, points: 50, lastSolveAt: "2026-08-07T15:00:00Z" }),
      entry("earlier", { patched: 5, points: 50, lastSolveAt: "2026-08-07T12:00:00Z" }),
    ]);
    expect(ranked.map((e) => e.login)).toEqual(["earlier", "later"]);
  });

  it("only consults time when BOTH points and items are tied", () => {
    // `early` got there first but completed fewer items — it must still lose.
    const ranked = rankByStanding([
      entry("early", { patched: 3, points: 30, lastSolveAt: "2026-08-07T09:00:00Z" }),
      entry("late", { patched: 4, points: 30, lastSolveAt: "2026-08-07T23:00:00Z" }),
    ]);
    expect(ranked.map((e) => e.login)).toEqual(["late", "early"]);
  });

  it("sorts a fully tied entry without a solve time after one with it", () => {
    const ranked = rankByStanding([
      entry("no-time", { patched: 5, points: 50, lastSolveAt: null }),
      entry("timed", { patched: 5, points: 50, lastSolveAt: "2026-08-07T12:00:00Z" }),
    ]);
    expect(ranked.map((e) => e.login)).toEqual(["timed", "no-time"]);
  });

  it("treats an unparseable timestamp like a missing one", () => {
    const ranked = rankByStanding([
      entry("garbage", { patched: 5, points: 50, lastSolveAt: "not-a-date" }),
      entry("timed", { patched: 5, points: 50, lastSolveAt: "2026-08-07T12:00:00Z" }),
    ]);
    expect(ranked.map((e) => e.login)).toEqual(["timed", "garbage"]);
  });

  it("keeps the source order when nothing breaks the tie", () => {
    const ranked = rankByStanding([
      entry("first", { patched: 5, points: 50 }),
      entry("second", { patched: 5, points: 50 }),
    ]);
    expect(ranked.map((e) => [e.login, e.rank])).toEqual([
      ["first", 1],
      ["second", 2],
    ]);
  });

  it("stamps sequential ranks across a mixed field", () => {
    const ranked = rankByStanding([
      entry("d", { patched: 1, points: 10 }),
      entry("a", { patched: 7, points: 70 }),
      entry("c", { patched: 3, points: 100 }),
      entry("b", { patched: 4, points: 100 }),
    ]);
    expect(ranked.map((e) => [e.login, e.rank])).toEqual([
      ["b", 1],
      ["c", 2],
      ["a", 3],
      ["d", 4],
    ]);
  });
});

const withModules = (
  login: string,
  patched: number,
  points: number,
  mods: LeaderboardEntry["modules"],
): LeaderboardEntry => ({
  rank: 0, login, team: null, points, patched, failed: 0, total: 0,
  apps: {}, updatedAt: null, lastSolveAt: null, modules: mods,
});

describe("compareStanding across modules", () => {
  it("counts completion across every module, not just patching, for the tiebreak", () => {
    // Equal points. ada: 0 patches but 12 quiz answers; bob: 1 patch, no quiz.
    const ada = withModules("ada", 0, 120, {
      quiz: { points: 120, completed: 12, lastActivityAt: null, detail: { kind: "quiz", answered: 12, total: 15, points: 120 } },
    });
    const bob = withModules("bob", 1, 120, {
      "secure-development": { points: 120, completed: 1, lastActivityAt: null, detail: { kind: "secure-development", apps: {} } },
    });
    expect(rankByStanding([bob, ada]).map((e) => e.login)).toEqual(["ada", "bob"]);
  });

  it("falls back to `patched` for the tiebreak when a source supplies no modules map", () => {
    const a = withModules("a", 5, 90, {});
    const b = withModules("b", 3, 90, {});
    expect(rankByStanding([b, a]).map((e) => e.login)).toEqual(["a", "b"]);
  });

  // The mirror image of the phase-2 ranking bug, which only ever got tested
  // with the quiz DISABLED: on an event with secure-development disabled, no
  // row carries a secure-development block at all, so `completedCount` falls
  // back to `patched` on every row — and `patched` is 0 on every row, because
  // there is no scorer feeding it. The items tiebreak must still count
  // answers rather than collapse to every row's 0.
  it("breaks points ties on module completions when there is no secure-development module", () => {
    const quiz = (login: string, points: number, answered: number) =>
      withModules(login, 0, points, {
        quiz: {
          points,
          completed: answered,
          lastActivityAt: null,
          detail: { kind: "quiz", answered, total: 10, points },
        },
      });
    // Equal points: grinder answered four questions, hoarder one.
    expect(rankByStanding([quiz("hoarder", 40, 1), quiz("grinder", 40, 4)]).map((e) => e.login))
      .toEqual(["grinder", "hoarder"]);
    // …and points still come first.
    expect(rankByStanding([quiz("cheap", 20, 4), quiz("dear", 50, 2)]).map((e) => e.login))
      .toEqual(["dear", "cheap"]);
  });

  it("breaks ties on the earliest activity across modules", () => {
    const early = withModules("early", 1, 10, {
      quiz: { points: 10, completed: 1, lastActivityAt: "2026-08-01T10:00:00.000Z", detail: { kind: "quiz", answered: 1, total: 5, points: 10 } },
    });
    const late = withModules("late", 1, 10, {
      quiz: { points: 10, completed: 1, lastActivityAt: "2026-08-01T12:00:00.000Z", detail: { kind: "quiz", answered: 1, total: 5, points: 10 } },
    });
    expect(rankByStanding([late, early]).map((e) => e.login)).toEqual(["early", "late"]);
  });
});

// #583. At the RTS event three teams finished tied at 5,308 with every item
// done. The board ranked them by who finished Secure Development first and
// ignored when they finished Jeopardy. The rule is the contestant one:
// points, then items completed, then whoever earned their LAST points first,
// across every module.
describe("compareTeamStanding", () => {
  const rts = (slug: string, sdLast: string, jeoLast: string, points = 5308, completed = 18): TeamStanding => ({
    rank: 0,
    slug,
    name: slug,
    captain: "",
    points,
    members: [],
    lastSolveAt: sdLast,
    modules: {
      "secure-development": { points: 668, completed: 321, lastActivityAt: sdLast, detail: { kind: "secure-development", apps: {} } },
      classic: { points: 4650, completed, lastActivityAt: jeoLast, detail: { kind: "classic", solved: completed, total: 18, points: 4650 } },
    },
  });
  const provart = rts("provart", "2026-10-08T12:35:30.995Z", "2026-10-09T16:59:32.540Z");
  const mortadela = rts("mortadela-s", "2026-10-09T05:15:55.389Z", "2026-10-09T17:19:32.531Z");
  const oxguardians = rts("oxguardians", "2026-10-09T15:40:09.998Z", "2026-10-09T16:59:08.114Z");

  it("puts the team that earned its final points first ahead, across modules (the RTS tie)", () => {
    const order = [provart, mortadela, oxguardians].sort(compareTeamStanding).map((t) => t.slug);
    expect(order).toEqual(["oxguardians", "provart", "mortadela-s"]);
  });

  it("never lets time beat points", () => {
    const behind = { ...oxguardians, slug: "behind", points: 5307 };
    expect([behind, mortadela].sort(compareTeamStanding).map((t) => t.slug)).toEqual(["mortadela-s", "behind"]);
  });

  it("breaks a points tie on items completed before time", () => {
    const fewer = rts("fewer", "2026-10-07T00:00:00.000Z", "2026-10-07T00:00:00.000Z", 5308, 17);
    expect([fewer, mortadela].sort(compareTeamStanding).map((t) => t.slug)).toEqual(["mortadela-s", "fewer"]);
  });

  it("sorts a team with no activity time after those with one", () => {
    const none: TeamStanding = { rank: 0, slug: "none", name: "none", captain: "", points: 5308, members: [], modules: {} };
    expect([none, provart].sort(compareTeamStanding)[0].slug).toBe("provart");
  });
});
