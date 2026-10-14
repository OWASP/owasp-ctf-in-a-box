// #188 against a live Redis: first blood is read off the members' real
// `ctf:classic:solves:<login>` hashes, and the Support tab's progress reset
// (RESET_MODULE_SOLVES_SCRIPT, run for real) takes it away with the rows —
// no stored marker is left behind to name a contestant whose solves are gone.
// The mocked team-solve-counts suite pins the fold; this one pins it against
// what Redis actually returns for HGETALL and what the reset script actually
// deletes. See live-redis.ts for the harness.
//
// The team list is mocked (it is a SCAN over every team on the box); the
// logins are run-unique, so the real solves keys never meet another suite's.

import { afterAll, describe, expect, it, vi } from "vitest";
import { RUN, freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));
const teams = vi.hoisted(() => ({ list: [] as { slug: string; name: string; members: string[] }[] }));
vi.mock("@/lib/team-store", () => ({ listTeams: async () => teams.list }));

describe.skipIf(!liveConfigured)("first blood against a live Redis", () => {
  const K = {
    points: liveKey("firstblood", "points"),
    solved: liveKey("firstblood", "solved"),
    solvecount: liveKey("firstblood", "solvecount"),
    lastAt: liveKey("firstblood", "lastAt"),
  };
  const touched: string[] = [];

  async function load() {
    const { classicSolvesKey, classicAttemptsKey } = await import("@/lib/classic-keys");
    const { teamSolveBoard } = await import("@/lib/team-solve-counts");
    const { RESET_MODULE_SOLVES_SCRIPT } = await import("@/lib/admin-ops-store");
    const { upstashEval, upstashPipeline } = await import("@/lib/upstash");
    return { classicSolvesKey, classicAttemptsKey, teamSolveBoard, RESET_MODULE_SOLVES_SCRIPT, upstashEval, upstashPipeline };
  }

  afterAll(async () => {
    if (!liveConfigured) return;
    const { upstashPipeline } = await load();
    await upstashPipeline([["DEL", ...Object.values(K), ...touched]]);
  });

  /** A solve row exactly as SUBMIT_SCRIPT writes it. */
  async function solve(login: string, id: string, at: string) {
    const { classicSolvesKey, upstashPipeline } = await load();
    touched.push(classicSolvesKey(login));
    const [r] = await upstashPipeline([["HSET", classicSolvesKey(login), id, `{"points":10,"at":"${at}"}`]]);
    expect(r.error).toBeUndefined();
  }

  it("names the earliest solver, and the next one once a progress reset clears them", async () => {
    const { classicSolvesKey, classicAttemptsKey, teamSolveBoard, RESET_MODULE_SOLVES_SCRIPT, upstashEval } = await load();
    const ada = `vt-${RUN}-${freshId("ada")}`;
    const bob = `vt-${RUN}-${freshId("bob")}`;
    const c1 = freshId("c");
    teams.list = [{ slug: freshId("team"), name: "Red", members: [ada, bob] }];
    await solve(ada, c1, "2026-10-01T12:00:01.000Z");
    await solve(bob, c1, "2026-10-01T12:00:02.000Z");

    const before = await teamSolveBoard("classic");
    expect(before?.firstBlood.get(c1)).toEqual({ login: ada, at: "2026-10-01T12:00:01.000Z" });
    expect(before?.counts.get(c1)).toBe(1);

    touched.push(classicAttemptsKey(ada));
    await upstashEval(
      RESET_MODULE_SOLVES_SCRIPT,
      [classicSolvesKey(ada), classicAttemptsKey(ada), K.points, K.solved, K.solvecount, K.lastAt],
      [ada],
    );

    const after = await teamSolveBoard("classic");
    expect(after?.firstBlood.get(c1)).toEqual({ login: bob, at: "2026-10-01T12:00:02.000Z" });
  });

  it("drops the first blood entirely when its only solver is reset", async () => {
    const { classicSolvesKey, classicAttemptsKey, teamSolveBoard, RESET_MODULE_SOLVES_SCRIPT, upstashEval } = await load();
    const ada = `vt-${RUN}-${freshId("ada")}`;
    const c1 = freshId("c");
    teams.list = [{ slug: freshId("team"), name: "Red", members: [ada] }];
    await solve(ada, c1, "2026-10-01T12:00:01.000Z");
    expect((await teamSolveBoard("classic"))?.firstBlood.has(c1)).toBe(true);

    touched.push(classicAttemptsKey(ada));
    await upstashEval(
      RESET_MODULE_SOLVES_SCRIPT,
      [classicSolvesKey(ada), classicAttemptsKey(ada), K.points, K.solved, K.solvecount, K.lastAt],
      [ada],
    );

    const after = await teamSolveBoard("classic");
    expect(after).not.toBeNull();
    expect(after?.firstBlood.has(c1)).toBe(false);
  });
});
