// FORCE_ADD_SCRIPT (admin-ops-store.ts) EXECUTED against a live Redis on
// run-unique teams and logins: the organizer's add/move for a player
// stranded after registration closed (#597). The mocked suite pins what the
// store hands the script; this pins what the script does with it.
// See live-redis.ts for the harness.

import { afterAll, describe, expect, it, vi } from "vitest";
import { RUN, liveConfigured } from "./live-redis";

vi.mock("server-only", () => ({}));

describe.skipIf(!liveConfigured)("FORCE_ADD_SCRIPT against a live Redis", () => {
  const used: string[] = [];
  const team = (slug: string) => {
    const keys = [`ctf:team:fa-${RUN}-${slug}`, `ctf:team:fa-${RUN}-${slug}:members`];
    used.push(...keys);
    return { slug: `fa-${RUN}-${slug}`, team: keys[0], members: keys[1] };
  };
  const user = (login: string) => {
    const k = `ctf:user:${login}`;
    used.push(k);
    return k;
  };

  async function load() {
    const { FORCE_ADD_SCRIPT } = await import("@/lib/admin-ops-store");
    const { upstashEval, upstashPipeline } = await import("@/lib/upstash");
    return { script: FORCE_ADD_SCRIPT, upstashEval, pipeline: upstashPipeline };
  }

  afterAll(async () => {
    const { pipeline } = await load();
    if (used.length) await pipeline([["DEL", ...used]]);
  });

  const NOW = "2026-10-11T18:00:00.000Z";

  it("adds a teamless player: member set, team and joinedAt, firstTeamAt kept", async () => {
    const { script, upstashEval, pipeline } = await load();
    const red = team("red");
    const alice = `Fa${RUN}Alice`;
    const ak = user(alice);
    await pipeline([
      ["HSET", red.team, "name", "Red", "captain", "cap"],
      ["SADD", red.members, "cap"],
      ["HSET", ak, "firstTeamAt", "2026-10-01T00:00:00.000Z"],
    ]);
    expect(await upstashEval(script, [red.team, red.members, ak], [alice, red.slug, "4", NOW])).toEqual(["ok", ""]);
    const [isMember, fields] = await pipeline([
      ["SISMEMBER", red.members, alice],
      ["HMGET", ak, "team", "joinedAt", "firstTeamAt"],
    ]);
    expect(isMember.result).toBe(1);
    expect(fields.result).toEqual([red.slug, NOW, "2026-10-01T00:00:00.000Z"]);
  });

  it("moves a player, deleting their old team and its join code when it empties", async () => {
    const { script, upstashEval, pipeline } = await load();
    const blue = team("blue");
    const green = team("green");
    const bob = `fa-${RUN}-bob`;
    const bk = user(bob);
    const code = `ctf:joincode:fa${RUN}`.toLowerCase();
    used.push(code);
    await pipeline([
      ["HSET", blue.team, "name", "Blue", "captain", bob, "joinCode", `fa${RUN}`.toLowerCase()],
      ["SADD", blue.members, bob],
      ["SET", code, blue.slug],
      ["HSET", bk, "team", blue.slug, "joinedAt", "2026-10-01T00:00:00.000Z"],
      ["HSET", green.team, "name", "Green", "captain", "g"],
      ["SADD", green.members, "g"],
    ]);
    // Bob captains Blue, but alone: the move is allowed, and Blue goes.
    expect(await upstashEval(script, [green.team, green.members, bk], [bob, green.slug, "4", NOW])).toEqual(["ok", blue.slug]);
    const gone = await pipeline([["EXISTS", blue.team], ["EXISTS", blue.members], ["EXISTS", code], ["SISMEMBER", green.members, bob], ["HGET", bk, "team"]]);
    expect(gone.map((r) => r.result)).toEqual([0, 0, 0, 1, green.slug]);
  });

  it("refuses a full team unless the cap is overridden, writing nothing on refusal", async () => {
    const { script, upstashEval, pipeline } = await load();
    const full = team("full");
    const carol = `fa-${RUN}-carol`;
    const ck = user(carol);
    await pipeline([
      ["HSET", full.team, "name", "Full", "captain", "a"],
      ["SADD", full.members, "a", "b"],
    ]);
    expect(await upstashEval(script, [full.team, full.members, ck], [carol, full.slug, "2", NOW])).toEqual(["full", ""]);
    const [n1, t1] = await pipeline([["SCARD", full.members], ["HGET", ck, "team"]]);
    expect([n1.result, t1.result]).toEqual([2, null]);
    expect(await upstashEval(script, [full.team, full.members, ck], [carol, full.slug, "", NOW])).toEqual(["ok", ""]);
    const [n2] = await pipeline([["SCARD", full.members]]);
    expect(n2.result).toBe(3);
  });

  // The member set and the player's record can disagree after a partial
  // write. A player already in the set is not counted again against the cap,
  // and the add repairs whichever side is missing.
  it("adds a player listed in a full team's set but whose record names no team, and repairs the record", async () => {
    const { script, upstashEval, pipeline } = await load();
    const t = team("drift-set");
    const erin = `fa-${RUN}-erin`;
    const ek = user(erin);
    await pipeline([
      ["HSET", t.team, "name", "Drift", "captain", "a"],
      ["SADD", t.members, "a", erin],
    ]);
    expect(await upstashEval(script, [t.team, t.members, ek], [erin, t.slug, "2", NOW])).toEqual(["ok", ""]);
    const [n, tm] = await pipeline([["SCARD", t.members], ["HGET", ek, "team"]]);
    expect([n.result, tm.result]).toEqual([2, t.slug]);
  });

  it("adds a player whose record names the team but who is missing from its set, keeping the team", async () => {
    const { script, upstashEval, pipeline } = await load();
    const t = team("drift-hash");
    const finn = `fa-${RUN}-finn`;
    const fk = user(finn);
    await pipeline([
      ["HSET", t.team, "name", "Drift", "captain", "a"],
      ["SADD", t.members, "a"],
      ["HSET", fk, "team", t.slug],
    ]);
    expect(await upstashEval(script, [t.team, t.members, fk], [finn, t.slug, "4", NOW])).toEqual(["ok", ""]);
    const [members, exists] = await pipeline([["SMEMBERS", t.members], ["EXISTS", t.team]]);
    expect((members.result as string[]).sort()).toEqual(["a", finn].sort());
    expect(exists.result).toBe(1);
  });

  it("refuses the captain of a team with other members, a player already there, and a missing team", async () => {
    const { script, upstashEval, pipeline } = await load();
    const home = team("home");
    const away = team("away");
    const dave = `fa-${RUN}-dave`;
    const dk = user(dave);
    await pipeline([
      ["HSET", home.team, "name", "Home", "captain", dave],
      ["SADD", home.members, dave, "mate"],
      ["HSET", dk, "team", home.slug],
      ["HSET", away.team, "name", "Away", "captain", "x"],
      ["SADD", away.members, "x"],
    ]);
    expect(await upstashEval(script, [away.team, away.members, dk], [dave, away.slug, "4", NOW])).toEqual(["is-captain", home.slug]);
    expect(await upstashEval(script, [home.team, home.members, dk], [dave, home.slug, "4", NOW])).toEqual(["already-member", home.slug]);
    const ghost = team("ghost");
    expect(await upstashEval(script, [ghost.team, ghost.members, dk], [dave, ghost.slug, "4", NOW])).toEqual(["no-team", ""]);
    const after = await pipeline([["SMEMBERS", home.members], ["SCARD", away.members], ["HGET", dk, "team"]]);
    expect((after[0].result as string[]).sort()).toEqual([dave, "mate"].sort());
    expect(after[1].result).toBe(1);
    expect(after[2].result).toBe(home.slug);
  });
});
