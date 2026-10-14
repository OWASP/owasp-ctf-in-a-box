// The captain-only team scripts (REMOVE_MEMBER, RENAME, TRANSFER_CAPTAIN,
// DISBAND, REGENERATE_CODE) EXECUTED against a live Redis through the store's
// own API, on run-unique teams and logins. The guard each one relies on is
// `HGET captain == caller` inside the script, so the refusals are asserted to
// be no-ops, not just to return the right message.
//
// The join-code cases include concurrent calls: the code a script deletes has
// to be the one the team holds at the moment of the write, or a code nobody
// can see keeps resolving to the team (or to a team that no longer exists).
//
// Gating comes from live-redis.ts: skipped without the env, a FAILURE when
// CTF_LUA_SUITES_REQUIRED is set.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RUN, liveConfigured } from "./live-redis";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    throw new Error("the cookie fallback must not be used when TEAM_WRITES_ENABLED=true");
  },
}));

const P = ["c1", "c2", "c3", "c4"].map((p) => `vc-${RUN}-${p}`);
const USER_KEYS = P.map((p) => `ctf:user:${p}`);

describe.skipIf(!liveConfigured)("captain-only team scripts against a live Redis (throwaway keys)", () => {
  let store: typeof import("@/lib/team-store");
  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];
  const slugs: string[] = [];

  /** Every join-code key that resolves to `slug` right now. */
  async function codesFor(slug: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = "0";
    do {
      const [scan] = await pipeline([["SCAN", cursor, "MATCH", "ctf:joincode:*", "COUNT", "1000"]]);
      const [next, keys] = scan.result as [string, string[]];
      cursor = next;
      if (keys.length) {
        const values = await pipeline(keys.map((k) => ["GET", k]));
        keys.forEach((k, i) => {
          if (values[i].result === slug) found.push(k.slice("ctf:joincode:".length));
        });
      }
    } while (cursor !== "0");
    return found.sort();
  }

  async function heldCode(slug: string): Promise<string | null> {
    const [res] = await pipeline([["HGET", `ctf:team:${slug}`, "joinCode"]]);
    return typeof res.result === "string" ? res.result : null;
  }

  /** A fresh team of `members.length` with members[0] as captain. */
  async function team(label: string, members: string[]): Promise<string> {
    const created = await store.createTeam(members[0], `vc ${RUN} ${label}`);
    if (!created.ok || !created.team) throw new Error(`create failed: ${JSON.stringify(created)}`);
    const slug = created.team;
    slugs.push(slug);
    const code = await heldCode(slug);
    for (const m of members.slice(1)) {
      const joined = await store.joinTeam(m, code ?? "");
      if (!joined.ok) throw new Error(`join failed: ${JSON.stringify(joined)}`);
    }
    return slug;
  }

  async function cleanup() {
    const codeKeys: string[] = [];
    for (const slug of slugs) for (const c of await codesFor(slug)) codeKeys.push(`ctf:joincode:${c}`);
    const teamKeys = slugs.flatMap((s) => [`ctf:team:${s}`, `ctf:team:${s}:members`]);
    await pipeline([["DEL", ...USER_KEYS, ...teamKeys, ...codeKeys]]);
  }

  beforeAll(async () => {
    vi.stubEnv("TEAM_WRITES_ENABLED", "true");
    store = await import("@/lib/team-store");
    ({ upstashPipeline: pipeline } = await import("@/lib/upstash"));
    await pipeline([["DEL", ...USER_KEYS]]);
  });

  afterAll(async () => {
    await cleanup();
    vi.unstubAllEnvs();
  });

  it("removeMember: only the captain, only a member, never the captain; the removed player's team is cleared", async () => {
    const slug = await team("remove", P.slice(0, 3));
    expect(await store.removeMember(P[1], slug, P[2])).toEqual({ ok: false, error: "Only the team captain can do that" });
    expect(await store.removeMember(P[0], slug, P[3])).toMatchObject({ ok: false });
    expect(await store.removeMember(P[0], slug, P[0])).toMatchObject({ ok: false });
    const [before] = await pipeline([["SCARD", `ctf:team:${slug}:members`]]);
    expect(before.result).toBe(3);

    expect(await store.removeMember(P[0], slug, P[2])).toMatchObject({ ok: true });
    const [members, team2, joined] = await pipeline([
      ["SMEMBERS", `ctf:team:${slug}:members`],
      ["HGET", `ctf:user:${P[2]}`, "team"],
      ["HGET", `ctf:user:${P[2]}`, "joinedAt"],
    ]);
    expect((members.result as string[]).sort()).toEqual([P[0], P[1]].sort());
    expect(team2.result).toBeNull();
    expect(joined.result).toBeNull();
    await store.disbandTeam(P[0], slug);
  });

  it("renameTeam: a non-captain changes nothing; the captain's rename keeps the slug", async () => {
    const slug = await team("rename", P.slice(0, 2));
    expect(await store.renameTeam(P[1], slug, `vc ${RUN} hijack`)).toEqual({ ok: false, error: "Only the team captain can do that" });
    const [name1] = await pipeline([["HGET", `ctf:team:${slug}`, "name"]]);
    expect(name1.result).toBe(`vc ${RUN} rename`);
    expect(await store.renameTeam(P[0], slug, `vc ${RUN} renamed`)).toMatchObject({ ok: true, team: slug });
    const [name2] = await pipeline([["HGET", `ctf:team:${slug}`, "name"]]);
    expect(name2.result).toBe(`vc ${RUN} renamed`);
    await store.disbandTeam(P[0], slug);
  });

  it("transferCaptain: only the captain, only to a member", async () => {
    const slug = await team("transfer", P.slice(0, 2));
    expect(await store.transferCaptain(P[1], slug, P[1])).toEqual({ ok: false, error: "Only the team captain can do that" });
    expect(await store.transferCaptain(P[0], slug, P[3])).toMatchObject({ ok: false });
    const [c1] = await pipeline([["HGET", `ctf:team:${slug}`, "captain"]]);
    expect(c1.result).toBe(P[0]);
    expect(await store.transferCaptain(P[0], slug, P[1])).toMatchObject({ ok: true });
    const [c2] = await pipeline([["HGET", `ctf:team:${slug}`, "captain"]]);
    expect(c2.result).toBe(P[1]);
    await store.disbandTeam(P[1], slug);
  });

  it("regenerateCode: a non-captain changes nothing; the captain's swaps the code and its index", async () => {
    const slug = await team("regen", P.slice(0, 2));
    const old = await heldCode(slug);
    expect(await store.regenerateCode(P[1], slug)).toEqual({ ok: false, error: "Only the team captain can do that" });
    expect(await codesFor(slug)).toEqual([old]);

    const res = await store.regenerateCode(P[0], slug);
    expect(res).toMatchObject({ ok: true, team: slug });
    const fresh = await heldCode(slug);
    expect(fresh).not.toBe(old);
    expect(await codesFor(slug)).toEqual([fresh]);
    await store.disbandTeam(P[0], slug);
  });

  // Five regenerations at once: each deletes the code the team holds when it
  // runs, so exactly one code is left and it is the one on the team hash.
  // Deleting a code read before the script ran leaves the others resolving.
  it("concurrent regenerations leave exactly one code, the one the team holds", async () => {
    const slug = await team("race", P.slice(0, 1));
    const results = await Promise.all(Array.from({ length: 5 }, () => store.regenerateCode(P[0], slug)));
    const [codes, held] = [await codesFor(slug), await heldCode(slug)];
    await store.disbandTeam(P[0], slug);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(codes).toEqual([held]);
  });

  it("disbandTeam: a non-captain changes nothing; the captain's clears every member and the code, and user hashes survive", async () => {
    const slug = await team("disband", P.slice(0, 3));
    expect(await store.disbandTeam(P[1], slug)).toEqual({ ok: false, error: "Only the team captain can do that" });
    const [still] = await pipeline([["EXISTS", `ctf:team:${slug}`]]);
    expect(still.result).toBe(1);

    expect(await store.disbandTeam(P[0], slug)).toEqual({ ok: true, team: null });
    const gone = await pipeline([
      ["EXISTS", `ctf:team:${slug}`],
      ["EXISTS", `ctf:team:${slug}:members`],
    ]);
    expect(gone.map((r) => r.result)).toEqual([0, 0]);
    expect(await codesFor(slug)).toEqual([]);
    const users = await pipeline(P.slice(0, 3).flatMap((p) => [["EXISTS", `ctf:user:${p}`], ["HEXISTS", `ctf:user:${p}`, "team"]]));
    expect(users.map((r) => r.result)).toEqual([1, 0, 1, 0, 1, 0]);
  });

  // A regeneration racing a disband: whichever lands second, no code may be
  // left resolving to a team that no longer exists.
  it("a disband racing a regeneration leaves no code behind", async () => {
    for (let i = 0; i < 5; i++) {
      const slug = await team(`ghost${i}`, P.slice(0, 1));
      await Promise.all([store.regenerateCode(P[0], slug), store.disbandTeam(P[0], slug)]);
      const [exists] = await pipeline([["EXISTS", `ctf:team:${slug}`]]);
      if (exists.result === 0) expect(await codesFor(slug)).toEqual([]);
      else await store.disbandTeam(P[0], slug);
    }
  });
});
