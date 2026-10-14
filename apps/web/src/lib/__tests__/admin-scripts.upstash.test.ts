// The organizer override scripts (FORCE_REMOVE, FORCE_TRANSFER in
// admin-ops-store.ts) and the runtime-admin grant script (ADMINS in
// admin-store.ts) EXECUTED against a live Redis on run-unique keys. The
// mocked suites pin what the stores hand each script; these pin what the
// scripts do with it: every refusal writes nothing, and each write touches
// exactly what it names. See live-redis.ts for the harness.

import { afterAll, describe, expect, it, vi } from "vitest";
import { liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

describe.skipIf(!liveConfigured)("organizer override and admin-grant scripts against a live Redis", () => {
  const used: string[] = [];
  const key = (name: string) => {
    const k = liveKey("admin-scripts", name);
    used.push(k);
    return k;
  };

  async function load() {
    const ops = await import("@/lib/admin-ops-store");
    const admin = await import("@/lib/admin-store");
    const { upstashEval, upstashPipeline } = await import("@/lib/upstash");
    return { ops, admin, upstashEval, pipeline: upstashPipeline };
  }

  afterAll(async () => {
    const { pipeline } = await load();
    if (used.length) await pipeline([["DEL", ...used]]);
  });

  it("FORCE_REMOVE refuses a missing team, the captain and a non-member, writing nothing; then removes a member", async () => {
    const { ops, upstashEval, pipeline } = await load();
    const [team, members, alice, bob, carol] = ["fr-team", "fr-members", "fr-alice", "fr-bob", "fr-carol"].map(key);
    const run = (user: string, login: string, slug = "red") =>
      upstashEval(ops.FORCE_REMOVE_SCRIPT, [team, members, user], [login, slug]);

    expect(await run(bob, "bob")).toBe("no-team");
    await pipeline([
      ["HSET", team, "name", "Red", "captain", "alice"],
      ["SADD", members, "alice", "bob"],
      ["HSET", alice, "team", "red", "joinedAt", "2026-10-01T00:00:00Z"],
      ["HSET", bob, "team", "red", "joinedAt", "2026-10-01T00:00:00Z", "firstTeamAt", "2026-10-01T00:00:00Z"],
      ["HSET", carol, "team", "blue"],
    ]);
    expect(await run(alice, "alice")).toBe("is-captain");
    expect(await run(carol, "carol")).toBe("not-member");
    const [m1, a1, c1] = await pipeline([["SCARD", members], ["HGET", alice, "team"], ["HGET", carol, "team"]]);
    expect([m1.result, a1.result, c1.result]).toEqual([2, "red", "blue"]);

    expect(await run(bob, "bob")).toBe("ok");
    const [m2, team2, joined2, first2] = await pipeline([
      ["SMEMBERS", members],
      ["HGET", bob, "team"],
      ["HGET", bob, "joinedAt"],
      ["HGET", bob, "firstTeamAt"],
    ]);
    expect(m2.result).toEqual(["alice"]);
    expect(team2.result).toBeNull();
    expect(joined2.result).toBeNull();
    // `firstTeamAt` is a metric that outlives the membership.
    expect(first2.result).toBe("2026-10-01T00:00:00Z");
  });

  it("FORCE_REMOVE drops the member but leaves a user record that already names another team", async () => {
    const { ops, upstashEval, pipeline } = await load();
    const [team, members, dave] = ["fr2-team", "fr2-members", "fr2-dave"].map(key);
    await pipeline([
      ["HSET", team, "name", "Red", "captain", "alice"],
      ["SADD", members, "alice", "dave"],
      ["HSET", dave, "team", "blue", "joinedAt", "2026-10-02T00:00:00Z"],
    ]);
    expect(await upstashEval(ops.FORCE_REMOVE_SCRIPT, [team, members, dave], ["dave", "red"])).toBe("ok");
    const [m, t] = await pipeline([["SISMEMBER", members, "dave"], ["HGET", dave, "team"]]);
    expect(m.result).toBe(0);
    expect(t.result).toBe("blue");
  });

  it("FORCE_TRANSFER refuses a missing team and a non-member, writing nothing; then hands over", async () => {
    const { ops, upstashEval, pipeline } = await load();
    const [team, members] = ["ft-team", "ft-members"].map(key);
    const run = (login: string) => upstashEval(ops.FORCE_TRANSFER_SCRIPT, [team, members], [login]);

    expect(await run("bob")).toBe("no-team");
    const [exists] = await pipeline([["EXISTS", team]]);
    expect(exists.result).toBe(0);
    await pipeline([
      ["HSET", team, "name", "Red", "captain", "alice"],
      ["SADD", members, "alice", "bob"],
    ]);
    expect(await run("mallory")).toBe("not-member");
    const [c1] = await pipeline([["HGET", team, "captain"]]);
    expect(c1.result).toBe("alice");
    expect(await run("bob")).toBe("ok");
    const [c2] = await pipeline([["HGET", team, "captain"]]);
    expect(c2.result).toBe("bob");
  });

  it("ADMINS adds and removes a grant with one audit line each, capped, and returns the set", async () => {
    const { admin, upstashEval, pipeline } = await load();
    const [admins, audit] = ["ad-set", "ad-audit"].map(key);
    const run = (action: "add" | "remove", login: string, line: string) =>
      upstashEval(admin.ADMINS_SCRIPT, [admins, audit], [action, login, line, "1"]);

    expect(await run("add", "alice", "a1")).toEqual(["alice"]);
    expect(((await run("add", "bob", "a2")) as string[]).sort()).toEqual(["alice", "bob"]);
    // Idempotent add still records its line; the cap (index 1) keeps two.
    expect(((await run("add", "bob", "a3")) as string[]).sort()).toEqual(["alice", "bob"]);
    expect(await run("remove", "alice", "r1")).toEqual(["bob"]);
    const [lines, members] = await pipeline([["LRANGE", audit, 0, -1], ["SMEMBERS", admins]]);
    expect(lines.result).toEqual(["r1", "a3"]);
    expect(members.result).toEqual(["bob"]);
  });
});
