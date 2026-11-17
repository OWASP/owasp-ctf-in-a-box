// Executes RESET_MODULE_SOLVES_SCRIPT — a contestant's classic progress
// reset — against a real Redis via SRH, on run-unique keys. The mocked
// admin-ops-store suite pins which keys `resetUserProgress` hands the script;
// this one pins what the script does with them: this login's rows and totals
// go, nobody else's do, and each solved challenge's solve count drops by one.
// See live-redis.ts for the harness.

import { afterAll, describe, expect, it, vi } from "vitest";
import { RUN, freshId, liveConfigured, liveKey } from "./live-redis";
import { destructiveLiveRedisAllowed } from "./live-redis-guard";
import { scorerSolveWrite } from "./scorer-solve-write";

vi.mock("server-only", () => ({}));

// auth.ts builds its instance at import; vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.GITHUB_CLIENT_ID ??= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";
});

describe.skipIf(!liveConfigured)("RESET_MODULE_SOLVES_SCRIPT against a live Redis", () => {
  const K = {
    points: liveKey("reset", "points"),
    solved: liveKey("reset", "solved"),
    solvecount: liveKey("reset", "solvecount"),
    lastAt: liveKey("reset", "lastAt"),
  };
  const perLogin: string[] = [];

  let script: string;
  let upstashEval: (typeof import("@/lib/upstash"))["upstashEval"];
  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  async function load() {
    if (script) return;
    ({ RESET_MODULE_SOLVES_SCRIPT: script } = await import("@/lib/admin-ops-store"));
    ({ upstashEval, upstashPipeline: pipeline } = await import("@/lib/upstash"));
  }

  afterAll(async () => {
    if (pipeline) await pipeline([["DEL", ...Object.values(K), ...perLogin]]);
  });

  /** One login's classic-shaped progress: a solves row per id, an attempts
   *  row, the two totals, the award time, and a solve count per id. */
  async function seedLogin(login: string, ids: string[]) {
    await load();
    const solves = liveKey("reset", freshId("solves"));
    const attempts = liveKey("reset", freshId("attempts"));
    perLogin.push(solves, attempts);
    const cmds: (string | number)[][] = [
      ["HSET", K.points, login, 10 * ids.length],
      ["HSET", K.solved, login, ids.length],
      ["HSET", K.lastAt, login, "2026-10-01T12:00:00.000Z"],
      ["HSET", attempts, ids[0], '{"attempts":1}'],
    ];
    for (const id of ids) {
      cmds.push(["HSET", solves, id, '{"points":10,"at":"2026-10-01T12:00:00.000Z"}']);
      cmds.push(["HINCRBY", K.solvecount, id, 1]);
    }
    await pipeline(cmds);
    return { solves, attempts };
  }

  async function run(login: string, keys: { solves: string; attempts: string }) {
    return upstashEval(script, [keys.solves, keys.attempts, K.points, K.solved, K.solvecount, K.lastAt], [login]);
  }

  async function hget(key: string, field: string) {
    const [r] = await pipeline([["HGET", key, field]]);
    return r.result;
  }

  it("clears this login's rows, totals and award time, and decrements each solved challenge once", async () => {
    const ada = freshId("ada");
    const bob = freshId("bob");
    const [c1, c2] = [freshId("c"), freshId("c")];
    const adaKeys = await seedLogin(ada, [c1, c2]);
    await seedLogin(bob, [c1]);

    expect(await run(ada, adaKeys)).toEqual([1, 1, 1, 1, 2]);

    expect(await hget(K.points, ada)).toBeNull();
    expect(await hget(K.solved, ada)).toBeNull();
    // #522: the award time goes with the totals it orders.
    expect(await hget(K.lastAt, ada)).toBeNull();
    const [solvesLeft, attemptsLeft] = await pipeline([["EXISTS", adaKeys.solves], ["EXISTS", adaKeys.attempts]]);
    expect([solvesLeft.result, attemptsLeft.result]).toEqual([0, 0]);
    // c1 was solved by both; c2 by ada alone.
    expect(await hget(K.solvecount, c1)).toBe("1");
    expect(await hget(K.solvecount, c2)).toBe("0");
  });

  it("leaves every other login's totals and award time alone", async () => {
    const ada = freshId("ada");
    const bob = freshId("bob");
    const c1 = freshId("c");
    const adaKeys = await seedLogin(ada, [c1]);
    await seedLogin(bob, [c1]);

    await run(ada, adaKeys);

    expect(await hget(K.points, bob)).toBe("10");
    expect(await hget(K.solved, bob)).toBe("1");
    expect(await hget(K.lastAt, bob)).toBe("2026-10-01T12:00:00.000Z");
  });
});

// deleteUser against the real keyspace: every per-player key family the stores
// write is seeded for one player made through the app's better-auth instance,
// and after the delete none of it is left: the user row, its accounts, its
// sessions and its username index go through the adapter, and the GitHub link
// is released with the login on the re-link blocklist. The team, target and
// challenge names are run-unique, so the shared aggregate hashes only ever
// gain and lose this test's fields.
describe.skipIf(!liveConfigured)("deleteUser against a live Redis", () => {
  const mate = crypto.randomUUID();
  const tag = RUN.replace(/[^a-z0-9]/g, "");
  const login = `vt${tag}`.slice(0, 39);
  const uname = `vt${tag}`.slice(0, 20);
  const slug = `vt-${tag}`.slice(0, 40);
  const target = `vt-${tag}`;
  const challenge = `vt-c-${tag}`;
  const buckets = ["team-join", "hint-reveal"];
  const at = "2026-10-01T12:00:00.000Z";
  const made: string[] = [];
  const logins: string[] = [];

  async function load() {
    const { auth } = await import("@/lib/auth");
    const { upstashPipeline } = await import("@/lib/upstash");
    return { ctx: await auth.$context, pipeline: upstashPipeline, ops: await import("@/lib/admin-ops-store") };
  }

  /** A GitHub player with a password account and one session, made through
   *  the adapter; the user-create hook links `gh` to them. */
  async function makePlayer(gh: string, username?: string) {
    const { ctx } = await load();
    const { user } = await ctx.internalAdapter.createOAuthUser(
      { name: gh, email: `${gh}@example.test`, emailVerified: true, image: null, login: gh, ...(username ? { username, displayUsername: username } : {}) } as never,
      { providerId: "github", accountId: `gh-${gh}` } as never,
    );
    made.push(user.id);
    logins.push(gh);
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: "x" });
    await ctx.internalAdapter.createSession(user.id);
    return user.id;
  }

  async function authState(id: string) {
    const { ctx } = await load();
    return {
      user: await ctx.internalAdapter.findUserById(id),
      accounts: (await ctx.internalAdapter.findAccounts(id)).length,
      sessions: (await ctx.internalAdapter.listSessions(id)).length,
    };
  }

  // Runs whether or not the tests passed: nothing this suite made outlives it.
  afterAll(async () => {
    const { ctx, pipeline } = await load().catch(() => ({ ctx: null, pipeline: null }));
    if (!ctx || !pipeline) return;
    for (const id of made) {
      await ctx.internalAdapter.deleteUser(id).catch(() => {});
      await pipeline([
        ["DEL", `ctf:user:${id}`, `ctf:user:${id}:hints`, `ctf:hints:at:${id}`, `ctf:quiz:answers:${id}`, `ctf:quiz:attempts:${id}`],
        ["DEL", `ctf:classic:solves:${id}`, `ctf:classic:attempts:${id}`, `ctf:classic:opened:${id}`, `ctf:link:user:${id}`],
        ["DEL", `ctf:score-hold:${id}`],
        ...buckets.map((b) => ["DEL", `ctf:rl:${b}:${id}`]),
        ...["ctf:hints:spent", "ctf:quiz:points", "ctf:quiz:answered", "ctf:quiz:lastAt", "ctf:classic:points", "ctf:classic:solved", "ctf:classic:lastAt", "ctf:link:at"].map((k) => ["HDEL", k, id]),
      ]);
    }
    await pipeline([
      ["DEL", `ctf:team:${slug}`, `ctf:team:${slug}:members`, `ctf:solves:${target}`, `ctf:user:${mate}`],
      ["HDEL", "ctf:classic:solvecount", challenge],
      ...logins.flatMap((l) => [
        ["DEL", `ctf:link:github:${l}`, `ctf:sd:held:by:${l}`],
        ["SREM", "ctf:sd:held:authors", l],
        ["SREM", "ctf:relink:blocked", l],
      ]),
    ]);
  });

  it("clears every per-player key family, removes the account, and blocks its GitHub login", async () => {
    const { pipeline, ops } = await load();
    const id = await makePlayer(login, uname);

    /** Every key and hash field that holds this player's event state, as [key, field?]. */
    const perPlayer: [string, string?][] = [
      [`ctf:user:${id}`],
      [`ctf:sd:held:by:${login}`],
      [`ctf:user:${id}:hints`],
      [`ctf:hints:at:${id}`],
      ["ctf:hints:spent", id],
      [`ctf:quiz:answers:${id}`],
      [`ctf:quiz:attempts:${id}`],
      ["ctf:quiz:points", id],
      ["ctf:quiz:answered", id],
      ["ctf:quiz:lastAt", id],
      [`ctf:classic:solves:${id}`],
      [`ctf:classic:attempts:${id}`],
      [`ctf:classic:opened:${id}`],
      ["ctf:classic:points", id],
      ["ctf:classic:solved", id],
      ["ctf:classic:lastAt", id],
      [`ctf:solves:${target}`, `${id}:${challenge}`],
      ...buckets.map((b): [string, string?] => [`ctf:rl:${b}:${id}`]),
    ];

    const solveRow = JSON.stringify({ points: 10, at });
    const attemptRow = JSON.stringify({ attempts: 1, firstAt: at, lastAt: at });
    const seeded = await pipeline([
      ["HSET", `ctf:sd:held:by:${login}`, "owasp/x#1", "{}"],
      ["SADD", "ctf:sd:held:authors", login],
      ["HSET", `ctf:team:${slug}`, "name", "VT", "captain", mate],
      ["SADD", `ctf:team:${slug}:members`, mate, id],
      ["HSET", `ctf:user:${mate}`, "team", slug],
      ["HSET", `ctf:user:${id}`, "team", slug, "joinedAt", at, "firstTeamAt", at],
      ["SADD", `ctf:user:${id}:hints`, `classic:${challenge}:0`],
      ["HSET", `ctf:hints:at:${id}`, `classic:${challenge}:0`, at],
      ["HSET", "ctf:hints:spent", id, 5],
      ["HSET", `ctf:quiz:answers:${id}`, "q1", "1"],
      ["HSET", `ctf:quiz:attempts:${id}`, "q1", attemptRow],
      ["HSET", "ctf:quiz:points", id, 10],
      ["HSET", "ctf:quiz:answered", id, 1],
      ["HSET", "ctf:quiz:lastAt", id, at],
      ["HSET", `ctf:solves:${target}`, `${id}:${challenge}`, at, `${mate}:${challenge}`, at],
      ...buckets.map((b) => ["SET", `ctf:rl:${b}:${id}`, 1, "EX", 600]),
      ["HSET", `ctf:classic:solves:${id}`, challenge, solveRow],
      ["HSET", `ctf:classic:attempts:${id}`, challenge, attemptRow],
      ["HSET", `ctf:classic:opened:${id}`, challenge, at],
      ["HSET", "ctf:classic:points", id, 10],
      ["HSET", "ctf:classic:solved", id, 1],
      ["HSET", "ctf:classic:lastAt", id, at],
      ["HINCRBY", "ctf:classic:solvecount", challenge, 2],
    ]);
    expect(seeded.filter((r) => r.error)).toEqual([]);

    // Every family, the account and the link are really there before the
    // delete, so "gone" below proves the delete removed them.
    const present = (await pipeline(perPlayer.map(([k, f]) => (f ? ["HEXISTS", k, f] : ["EXISTS", k])))).map((r) => r.result);
    expect(present).toEqual(perPlayer.map(() => 1));
    expect(await authState(id)).toMatchObject({ user: { id }, accounts: 2, sessions: 1 });
    const [linked, unameIdx] = await pipeline([
      ["GET", `ctf:link:github:${login}`],
      ["SCARD", `ctf:auth:user:by:username:${uname}`],
    ]);
    expect([linked.result, unameIdx.result]).toEqual([id, 1]);

    const result = await ops.deleteUser(id, { id: crypto.randomUUID(), name: "organizer" });
    expect(result.leftTeam).toBe(slug);

    const after = await pipeline(perPlayer.map(([k, f]) => (f ? ["HEXISTS", k, f] : ["EXISTS", k])));
    expect(Object.fromEntries(perPlayer.map(([k, f], i) => [f ? `${k}#${f}` : k, after[i].result]))).toEqual(
      Object.fromEntries(perPlayer.map(([k, f]) => [f ? `${k}#${f}` : k, 0])),
    );
    expect(await authState(id)).toEqual({ user: null, accounts: 0, sessions: 0 });

    const [member, mateMember, mateSolve, classicCount, authRow, linkGithub, linkUser, linkAt, blocked, unameAfter, heldAuthor] =
      await pipeline([
        ["SISMEMBER", `ctf:team:${slug}:members`, id],
        ["SISMEMBER", `ctf:team:${slug}:members`, mate],
        ["HEXISTS", `ctf:solves:${target}`, `${mate}:${challenge}`],
        ["HGET", "ctf:classic:solvecount", challenge],
        ["HEXISTS", "ctf:auth:user", id],
        ["GET", `ctf:link:github:${login}`],
        ["GET", `ctf:link:user:${id}`],
        ["HEXISTS", "ctf:link:at", id],
        ["SISMEMBER", "ctf:relink:blocked", login],
        ["EXISTS", `ctf:auth:user:by:username:${uname}`],
        ["SISMEMBER", "ctf:sd:held:authors", login],
      ]);
    expect(member.result).toBe(0);
    expect(heldAuthor.result).toBe(0);
    expect(mateMember.result).toBe(1);
    expect(mateSolve.result).toBe(1);
    expect(classicCount.result).toBe("1");
    expect(authRow.result).toBe(0);
    expect([linkGithub.result, linkUser.result, linkAt.result]).toEqual([null, null, 0]);
    expect(blocked.result).toBe(1);
    // The username is free again.
    expect(unameAfter.result).toBe(0);

    // The same id again: nothing of it is left.
    await expect(ops.deleteUser(id, { id: crypto.randomUUID(), name: "organizer" })).rejects.toThrow("No such player.");
  });

  it("a delete whose auth step failed completes on the second call", async () => {
    const { ctx, pipeline, ops } = await load();
    const gh = `vt2${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    const classic = freshId("c");
    const seeded = await pipeline([
      ["HSET", `ctf:user:${id}`, "firstTeamAt", at],
      ["HSET", `ctf:solves:${target}`, `${id}:banked`, at],
      ["HSET", `ctf:classic:solves:${id}`, classic, JSON.stringify({ points: 10, at })],
      ["HSET", "ctf:classic:points", id, 10],
      ["HSET", "ctf:classic:solved", id, 1],
      ["HSET", `ctf:sd:held:by:${gh}`, "owasp/x#2", "{}"],
      ["SADD", "ctf:sd:held:authors", gh],
    ]);
    expect(seeded.filter((r) => r.error)).toEqual([]);
    const actor = { id: crypto.randomUUID(), name: "organizer" };
    const banked = async () =>
      (
        await pipeline([
          ["EXISTS", `ctf:user:${id}`],
          ["HEXISTS", `ctf:solves:${target}`, `${id}:banked`],
          ["HEXISTS", `ctf:classic:solves:${id}`, classic],
          ["HGET", "ctf:classic:points", id],
          ["EXISTS", `ctf:sd:held:by:${gh}`],
          ["SISMEMBER", "ctf:sd:held:authors", gh],
        ])
      ).map((r) => r.result);

    const spy = vi.spyOn(ctx.internalAdapter, "deleteAccounts").mockRejectedValueOnce(new Error("auth store: down"));
    try {
      await expect(ops.deleteUser(id, actor)).rejects.toThrow("auth store: down");
    } finally {
      spy.mockRestore();
    }
    // The account goes before any progress: with the account row still in
    // place the record, the Secure Development and classic solves and the
    // held scores are all still there, and the delete's own hold token is
    // gone, so later scores write.
    expect(await banked()).toEqual([1, 1, 1, "10", 1, 1]);
    const [hold] = await pipeline([["EXISTS", `ctf:score-hold:${id}`]]);
    expect(hold.result).toBe(0);
    expect((await authState(id)).user).toMatchObject({ id });

    await expect(ops.deleteUser(id, actor)).resolves.toMatchObject({ leftTeam: null });
    expect(await banked()).toEqual([0, 0, 0, null, 0, 0]);
    const [heldAfter] = await pipeline([["SMEMBERS", `ctf:score-hold:${id}`]]);
    expect(heldAfter.result).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(await authState(id)).toEqual({ user: null, accounts: 0, sessions: 0 });
    const [blocked] = await pipeline([["SISMEMBER", "ctf:relink:blocked", gh]]);
    expect(blocked.result).toBe(1);
  });

  it("a re-run finds a delete that failed after the account went by its marker, and finishes it", async () => {
    const { ctx, pipeline, ops } = await load();
    const gh = `vm1${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    // What a run that failed part way through the reset leaves: no account,
    // nothing the lookup counts, an aggregate field, and the marker.
    await ctx.internalAdapter.deleteUserSessions(id);
    await ctx.internalAdapter.deleteAccounts(id);
    await ctx.internalAdapter.deleteUser(id);
    await pipeline([["HSET", "ctf:quiz:points", id, 10], ["SET", `ctf:admin:deleting:${id}`, "1"]]);
    const actor = { id: crypto.randomUUID(), name: "organizer" };
    await expect(ops.deleteUser(id, actor)).resolves.toMatchObject({ leftTeam: null });
    const [points, marker] = await pipeline([["HEXISTS", "ctf:quiz:points", id], ["EXISTS", `ctf:admin:deleting:${id}`]]);
    expect([points.result, marker.result]).toEqual([0, 0]);
    // Finished: the same id again is No such player.
    await expect(ops.deleteUser(id, actor)).rejects.toThrow("No such player.");
  });

  it("a re-run after a failed membership removal finds the team through the record and removes the player from it", async () => {
    const { ctx, pipeline, ops } = await load();
    const gh = `vm2${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    const team = `vtm-${tag}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
    try {
      // What a first run that failed at the membership SREM leaves: no
      // account, the record still naming the team, the membership, the marker.
      await ctx.internalAdapter.deleteUserSessions(id);
      await ctx.internalAdapter.deleteAccounts(id);
      await ctx.internalAdapter.deleteUser(id);
      const seeded = await pipeline([
        ["HSET", `ctf:team:${team}`, "name", "VTM", "captain", mate],
        ["SADD", `ctf:team:${team}:members`, mate, id],
        ["HSET", `ctf:user:${id}`, "team", team, "joinedAt", at],
        ["SET", `ctf:admin:deleting:${id}`, "1"],
      ]);
      expect(seeded.filter((r) => r.error)).toEqual([]);
      await expect(ops.deleteUser(id, { id: crypto.randomUUID(), name: "organizer" })).resolves.toMatchObject({ leftTeam: team });
      const [member, mateStays, record, marker] = await pipeline([
        ["SISMEMBER", `ctf:team:${team}:members`, id],
        ["SISMEMBER", `ctf:team:${team}:members`, mate],
        ["EXISTS", `ctf:user:${id}`],
        ["EXISTS", `ctf:admin:deleting:${id}`],
      ]);
      expect([member.result, mateStays.result, record.result, marker.result]).toEqual([0, 1, 0, 0]);
    } finally {
      await pipeline([["DEL", `ctf:team:${team}`, `ctf:team:${team}:members`]]);
    }
  });

  it("a finished delete leaves its score-hold token and no account row, so the scorer answers deleted", async () => {
    const { pipeline, ops } = await load();
    const gh = `vd5${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    const [before] = await pipeline([["EXISTS", `ctf:score-hold:${id}`]]);
    expect(before.result).toBe(0);

    await ops.deleteUser(id, { id: crypto.randomUUID(), name: "organizer" });

    const [hold, row] = await pipeline([["SMEMBERS", `ctf:score-hold:${id}`], ["HEXISTS", "ctf:auth:user", id]]);
    expect(hold.result).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(row.result).toBe(0);
  });

  it("a second delete that fails after the first finished keeps the hold", async () => {
    const { ctx, pipeline, ops } = await load();
    const gh = `vd6${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    const actor = { id: crypto.randomUUID(), name: "organizer" };
    await ops.deleteUser(id, actor);
    // Event state written after A finished makes B pass the "No such player."
    // refusal with A's row already gone; B then fails before its row step.
    await pipeline([["HSET", `ctf:user:${id}`, "firstTeamAt", at]]);
    const spy = vi.spyOn(ctx.internalAdapter, "deleteAccounts").mockRejectedValueOnce(new Error("auth store: down"));
    try {
      await expect(ops.deleteUser(id, actor)).rejects.toThrow("auth store: down");
    } finally {
      spy.mockRestore();
    }
    // B's restore lifts nothing with the row gone: A's token and B's stay.
    const [hold, row] = await pipeline([["SCARD", `ctf:score-hold:${id}`], ["HEXISTS", "ctf:auth:user", id]]);
    expect(hold.result).toBe(2);
    expect(row.result).toBe(0);
  });

  it("restore lifts only its own token, and only while the account row exists", async () => {
    const { pipeline } = await load();
    const { holdScores, restoreAfterFailedDelete } = await import("@/lib/score-hold");
    const gh = `vd7${tag}`.slice(0, 39);
    const id = await makePlayer(gh);

    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    await holdScores(id, mine);
    await holdScores(id, theirs);
    await expect(restoreAfterFailedDelete(id, mine)).resolves.toBe("in-flight");
    const [left] = await pipeline([["SMEMBERS", `ctf:score-hold:${id}`]]);
    expect(left.result).toEqual([theirs]);
    await expect(restoreAfterFailedDelete(id, theirs)).resolves.toBe("restored");
    const [gone] = await pipeline([["EXISTS", `ctf:score-hold:${id}`]]);
    expect(gone.result).toBe(0);
  });

  it("A fails while B is in flight: B's hold token survives A's restore, and B finishes deleted", async () => {
    const { ctx, pipeline, ops } = await load();
    const { holdScores, restoreAfterFailedDelete } = await import("@/lib/score-hold");
    const gh = `vd8${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    const actor = { id: crypto.randomUUID(), name: "organizer" };

    // B holds; A holds, fails before its row step and restores. B's token is
    // still there, so the scorer keeps answering pending.
    const b = crypto.randomUUID();
    await holdScores(id, b);
    const original = ctx.internalAdapter.deleteAccounts.bind(ctx.internalAdapter);
    const spy = vi.spyOn(ctx.internalAdapter, "deleteAccounts").mockRejectedValueOnce(new Error("auth store: down"));
    try {
      await expect(ops.deleteUser(id, actor)).rejects.toThrow("auth store: down");
    } finally {
      spy.mockRestore();
    }
    const [mid, rowMid] = await pipeline([["SMEMBERS", `ctf:score-hold:${id}`], ["HEXISTS", "ctf:auth:user", id]]);
    expect(mid.result).toEqual([b]);
    expect(rowMid.result).toBe(1);

    // B finishes: the row goes with B's token still on the hold, so the
    // scorer answers deleted. B's own restore, after the fact, keeps it.
    await original(id);
    await ctx.internalAdapter.deleteUser(id);
    const [end, rowEnd] = await pipeline([["EXISTS", `ctf:score-hold:${id}`], ["HEXISTS", "ctf:auth:user", id]]);
    expect(end.result).toBe(1);
    expect(rowEnd.result).toBe(0);
    await expect(restoreAfterFailedDelete(id, b)).resolves.toBe("kept");
    const [still] = await pipeline([["SMEMBERS", `ctf:score-hold:${id}`]]);
    expect(still.result).toEqual([b]);
  });

  it("a grant claimed after the organizer check is removed with the account, and the id cannot claim again", async () => {
    const { ctx, pipeline, ops } = await load();
    const { CLAIM_SCRIPT } = await import("@/lib/admin-claim");
    const { upstashEval } = await import("@/lib/upstash");
    const gh = `vt4${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    const codeKey = `ctf:admin:code:vt-${RUN}`;
    const boot = `vt-boot-${RUN}`;
    // The grant lands after the refusal check and before the row delete: the
    // first auth write is where a concurrent claim would have slipped in.
    const original = ctx.internalAdapter.deleteUserSessions.bind(ctx.internalAdapter);
    const spy = vi.spyOn(ctx.internalAdapter, "deleteUserSessions").mockImplementationOnce(async (userId: string) => {
      const [added] = await pipeline([["SADD", "ctf:admin:grants", userId]]);
      expect(added.result).toBe(1);
      return original(userId);
    });
    try {
      const result = await ops.deleteUser(id, { id: crypto.randomUUID(), name: "organizer" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.warnings).toContain(ops.GRANT_CLAIMED_DURING_DELETE);
      const [granted, [line]] = (await pipeline([
        ["SISMEMBER", "ctf:admin:grants", id],
        ["LRANGE", "ctf:admin:audit", 0, 0],
      ])).map((r) => r.result) as [number, string[]];
      expect(granted).toBe(0);
      expect(JSON.parse(line)).toMatchObject({
        action: "ops:user-delete",
        player: id,
        grantRemoved: true,
        warning: ops.GRANT_CLAIMED_DURING_DELETE,
      });

      // With the row gone, even the bootstrap path refuses the id, so the
      // removal above leaves nothing for a later claim to race.
      const claim = await upstashEval(
        CLAIM_SCRIPT,
        ["ctf:admin:grants", "ctf:admin:claim:spent", codeKey, "ctf:admin:audit", "ctf:admin:grant-gen", "ctf:auth:user", `ctf:admin:reset-code:busy:${id}`],
        [id, gh, boot, boot, new Date().toISOString(), 499],
      );
      expect(claim).toEqual(["invalid"]);
      const [stillOut, spent] = await pipeline([
        ["SISMEMBER", "ctf:admin:grants", id],
        ["SISMEMBER", "ctf:admin:claim:spent", boot],
      ]);
      expect([stillOut.result, spent.result]).toEqual([0, 0]);
    } finally {
      spy.mockRestore();
      await pipeline([["SREM", "ctf:admin:grants", id], ["SREM", "ctf:admin:claim:spent", boot]]);
    }
  });

  it("a retry removes a grant a failed run left on the deleted account", async () => {
    const { ctx, pipeline, ops } = await load();
    const gh = `vt5${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    // What a run that failed at its grant SREM leaves: no account row, a grant.
    await ctx.internalAdapter.deleteUser(id);
    await pipeline([["SADD", "ctf:admin:grants", id]]);
    try {
      const result = await ops.deleteUser(id, { id: crypto.randomUUID(), name: "organizer" });
      expect(result.warnings).toContain(ops.ORPHAN_GRANT_REMOVED);
      const [granted] = await pipeline([["SISMEMBER", "ctf:admin:grants", id]]);
      expect(granted.result).toBe(0);
    } finally {
      await pipeline([["SREM", "ctf:admin:grants", id]]);
    }
  });

  it("unlinkGithub puts a scored link back with its time and deletes no account row", async () => {
    const { pipeline, ops } = await load();
    const gh = `vt6${tag}`.slice(0, 39);
    const id = await makePlayer(gh, `vt6${tag}`.slice(0, 20));
    const [before] = await pipeline([["HGET", "ctf:link:at", id]]);
    expect(typeof before.result).toBe("string");
    await pipeline([["HSET", `ctf:solves:${target}`, `${id}:api1`, at]]);
    try {
      await expect(ops.unlinkGithub(id, { id: crypto.randomUUID(), name: "organizer" })).rejects.toThrow(
        "This GitHub link has scored and cannot be removed.",
      );
      const [owner, pointer, time] = await pipeline([
        ["GET", `ctf:link:github:${gh}`],
        ["GET", `ctf:link:user:${id}`],
        ["HGET", "ctf:link:at", id],
      ]);
      expect([owner.result, pointer.result, time.result]).toEqual([id, gh, before.result]);
      expect((await authState(id)).accounts).toBe(2);
    } finally {
      await pipeline([["HDEL", `ctf:solves:${target}`, `${id}:api1`]]);
    }
  });

  it("unlinkGithub releases an unscored link and its github row for a player with a username and password", async () => {
    const { ctx, pipeline, ops } = await load();
    const gh = `vt7${tag}`.slice(0, 39);
    const id = await makePlayer(gh, `vt7${tag}`.slice(0, 20));
    await expect(ops.unlinkGithub(id, { id: crypto.randomUUID(), name: "organizer" })).resolves.toEqual({ login: gh });
    const [owner, pointer] = await pipeline([
      ["GET", `ctf:link:github:${gh}`],
      ["GET", `ctf:link:user:${id}`],
    ]);
    expect([owner.result, pointer.result]).toEqual([null, null]);
    expect((await ctx.internalAdapter.findAccounts(id)).map((a) => a.providerId)).toEqual(["credential"]);
  });

  const scorerWrite = (id: string, challenge: string, login = "") => scorerSolveWrite(target, id, at, challenge, login);

  it("unlinkGithub: a score resolved before the unlink and sent after it finished answers unlinked and writes nothing", async () => {
    const { pipeline, ops } = await load();
    const gh = `vh5${tag}`.slice(0, 39);
    const id = await makePlayer(gh, `vh5${tag}`.slice(0, 20));
    // Sync resolves the author's login to this player, then stalls.
    const [resolved] = await pipeline([["GET", `ctf:link:github:${gh}`]]);
    expect(resolved.result).toBe(id);
    await expect(ops.unlinkGithub(id, { id: crypto.randomUUID(), name: "organizer" })).resolves.toEqual({ login: gh });
    const [hold] = await pipeline([["EXISTS", `ctf:score-hold:${id}`]]);
    expect(hold.result).toBe(0);
    // The stalled score arrives with the hold gone: the link check refuses it.
    expect(await scorerWrite(id, "late1", gh)).toBe("unlinked");
    const [field] = await pipeline([["HEXISTS", `ctf:solves:${target}`, `${id}:late1`]]);
    expect(field.result).toBe(0);
  });

  it("the scorer's write lands while the login it was resolved through still names the player", async () => {
    const { pipeline } = await load();
    const gh = `vh6${tag}`.slice(0, 39);
    const id = await makePlayer(gh, `vh6${tag}`.slice(0, 20));
    try {
      expect(await scorerWrite(id, "live1", gh.toUpperCase())).toBe("ok");
      const [field] = await pipeline([["HEXISTS", `ctf:solves:${target}`, `${id}:live1`]]);
      expect(field.result).toBe(1);
    } finally {
      await pipeline([["HDEL", `ctf:solves:${target}`, `${id}:live1`]]);
    }
  });

  it("unlinkGithub holds a score resolved before the take: the scorer answers pending mid-unlink and writes nothing", async () => {
    const { ctx, pipeline, ops } = await load();
    const gh = `vh1${tag}`.slice(0, 39);
    const id = await makePlayer(gh, `vh1${tag}`.slice(0, 20));
    // Sync resolved the author's login to this player before the unlink began.
    const [resolved] = await pipeline([["GET", `ctf:link:github:${gh}`]]);
    expect(resolved.result).toBe(id);

    // The score reaches the scorer after the unlink's solve count found
    // nothing: the first account-row delete runs only after that count.
    let midUnlink: unknown;
    const original = ctx.internalAdapter.deleteAccount.bind(ctx.internalAdapter);
    const spy = vi.spyOn(ctx.internalAdapter, "deleteAccount").mockImplementationOnce(async (accountId: string) => {
      midUnlink = await scorerWrite(id, "held1", gh);
      return original(accountId);
    });
    try {
      await expect(ops.unlinkGithub(id, { id: crypto.randomUUID(), name: "organizer" })).resolves.toEqual({ login: gh });
    } finally {
      spy.mockRestore();
    }
    expect(midUnlink).toBe("pending");
    const [field, hold, owner, pointer] = await pipeline([
      ["HEXISTS", `ctf:solves:${target}`, `${id}:held1`],
      ["EXISTS", `ctf:score-hold:${id}`],
      ["GET", `ctf:link:github:${gh}`],
      ["GET", `ctf:link:user:${id}`],
    ]);
    expect(field.result).toBe(0);
    // Hold lifted and the login unlinked: sync's retry resolves nobody and
    // holds the score instead of scoring it.
    expect(hold.result).toBe(0);
    expect([owner.result, pointer.result]).toEqual([null, null]);
  });

  it("unlinkGithub on a scored link restores it and lifts its hold, so sync's retry scores", async () => {
    const { pipeline, ops } = await load();
    const gh = `vh2${tag}`.slice(0, 39);
    const id = await makePlayer(gh, `vh2${tag}`.slice(0, 20));
    await pipeline([["HSET", `ctf:solves:${target}`, `${id}:api1`, at]]);
    try {
      await expect(ops.unlinkGithub(id, { id: crypto.randomUUID(), name: "organizer" })).rejects.toThrow(
        "This GitHub link has scored and cannot be removed.",
      );
      const [hold, owner] = await pipeline([["EXISTS", `ctf:score-hold:${id}`], ["GET", `ctf:link:github:${gh}`]]);
      expect(hold.result).toBe(0);
      expect(owner.result).toBe(id);
      expect(await scorerWrite(id, "api2", gh)).toBe("ok");
    } finally {
      await pipeline([["HDEL", `ctf:solves:${target}`, `${id}:api1`, `${id}:api2`]]);
    }
  });

  it("unlinkGithub leaves a concurrent delete's hold token in place", async () => {
    const { pipeline, ops } = await load();
    const { holdScores } = await import("@/lib/score-hold");
    const gh = `vh3${tag}`.slice(0, 39);
    const id = await makePlayer(gh, `vh3${tag}`.slice(0, 20));
    const other = crypto.randomUUID();
    await holdScores(id, other);
    await ops.unlinkGithub(id, { id: crypto.randomUUID(), name: "organizer" });
    const [left] = await pipeline([["SMEMBERS", `ctf:score-hold:${id}`]]);
    expect(left.result).toEqual([other]);
  });

  it("a link restore after a delete completed between the take and a failed count recreates nothing and blocks the login", async () => {
    const { pipeline, ops } = await load();
    const { takeGithubLink, restoreGithubLink } = await import("@/lib/github-link");
    const gh = `vh4${tag}`.slice(0, 39);
    const id = await makePlayer(gh, `vh4${tag}`.slice(0, 20));
    const taken = await takeGithubLink(id);
    expect(taken).toMatchObject({ login: gh, ours: true });
    // The delete sees no link, so its own release blocks nothing.
    await ops.deleteUser(id, { id: crypto.randomUUID(), name: "organizer" });
    const [blockedBefore] = await pipeline([["SISMEMBER", "ctf:relink:blocked", gh]]);
    expect(blockedBefore.result).toBe(0);
    // The unlink's count then fails and it puts the link back.
    await expect(restoreGithubLink(id, taken!)).resolves.toBe("deleted");
    const [owner, pointer, time, blocked] = await pipeline([
      ["GET", `ctf:link:github:${gh}`],
      ["GET", `ctf:link:user:${id}`],
      ["HEXISTS", "ctf:link:at", id],
      ["SISMEMBER", "ctf:relink:blocked", gh],
    ]);
    expect([owner.result, pointer.result, time.result]).toEqual([null, null, 0]);
    expect(blocked.result).toBe(1);
  });

  it("unlinkGithub refuses a player with a password but no username and changes nothing", async () => {
    const { pipeline, ops } = await load();
    const gh = `vt8${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    await expect(ops.unlinkGithub(id, { id: crypto.randomUUID(), name: "organizer" })).rejects.toThrow(
      /cannot sign in without GitHub. First set a username/,
    );
    const [owner] = await pipeline([["GET", `ctf:link:github:${gh}`]]);
    expect(owner.result).toBe(id);
    expect((await authState(id)).accounts).toBe(2);
  });

  it("refuses an organizer and leaves the account in place", async () => {
    const { pipeline, ops } = await load();
    const gh = `vt3${tag}`.slice(0, 39);
    const id = await makePlayer(gh);
    await pipeline([["SADD", "ctf:admin:grants", id]]);
    try {
      await expect(ops.deleteUser(id, { id: crypto.randomUUID(), name: "organizer" })).rejects.toThrow(
        `${gh} is an organizer. Revoke their admin access first.`,
      );
      expect(await authState(id)).toMatchObject({ user: { id }, accounts: 2, sessions: 1 });
      const [linked] = await pipeline([["GET", `ctf:link:github:${gh}`]]);
      expect(linked.result).toBe(id);
    } finally {
      await pipeline([["SREM", "ctf:admin:grants", id]]);
    }
  });
});

// deleteAllAccounts against the real keyspace. It runs the master reset and
// wipes the account namespaces, so it is the LAST suite in this file and
// every assertion is about what this run seeded: the live suites run
// serially (--no-file-parallelism) and each seeds its own state. It deletes
// every account on the Redis it reaches, so it runs only against a throwaway
// one (destructiveLiveRedisAllowed in live-redis-guard.ts).
describe.skipIf(!liveConfigured || !destructiveLiveRedisAllowed())("deleteAllAccounts against a live Redis", () => {
  const sentinel = JSON.stringify({ at: "2026-01-01T00:00:00.000Z", action: `vt-sentinel-${RUN}` });
  const spentHash = `vt-spent-${RUN}`;
  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];
  // The reset inside freezes scoring and relocks the event in the real
  // settings hash and drops the real pause log; both are put back as they
  // were, or every later hint and grade suite on this Redis reads a frozen box.
  // Set only once both snapshot reads succeeded: without it the cleanup
  // leaves both keys alone rather than delete them with nothing to put back.
  let snapshotted = false;
  let settings: string[] = [];
  let pauses: string[] = [];

  afterAll(async () => {
    if (!pipeline) return;
    await pipeline([
      ["LREM", "ctf:admin:audit", 0, sentinel],
      ["SREM", "ctf:admin:claim:spent", spentHash],
      ...(snapshotted
        ? [
            ["DEL", "ctf:admin:settings", "ctf:admin:pauses"],
            ...(settings.length ? [["HSET", "ctf:admin:settings", ...settings]] : []),
            ...(pauses.length ? [["RPUSH", "ctf:admin:pauses", ...pauses]] : []),
          ]
        : []),
    ]);
  });

  async function scanAll(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = "0";
    do {
      const [page] = await pipeline([["SCAN", cursor, "MATCH", pattern, "COUNT", 1000]]);
      if (page.error) throw new Error(page.error);
      const [next, keys] = page.result as [string, string[]];
      cursor = next;
      found.push(...keys);
    } while (cursor !== "0");
    return found;
  }

  it("empties the accounts and grants, keeps the spent bootstrap code and the audit history", async () => {
    ({ upstashPipeline: pipeline } = await import("@/lib/upstash"));
    const { auth } = await import("@/lib/auth");
    const ctx = await auth.$context;
    const { deleteAllAccounts } = await import("@/lib/admin-ops-store");
    const { isAdminGrantee } = await import("@/lib/admin-grants");
    const [snapSettings, snapPauses] = await pipeline([
      ["HGETALL", "ctf:admin:settings"],
      ["LRANGE", "ctf:admin:pauses", 0, -1],
    ]);
    if (snapSettings.error || snapPauses.error) {
      throw new Error(`settings snapshot failed: ${snapSettings.error ?? snapPauses.error}`);
    }
    settings = (snapSettings.result as string[] | null) ?? [];
    pauses = (snapPauses.result as string[] | null) ?? [];
    snapshotted = true;

    const ids: string[] = [];
    const ghs: string[] = [];
    for (const n of [1, 2]) {
      const gh = `vtall${n}${RUN.replace(/[^a-z0-9]/g, "")}`.slice(0, 39);
      ghs.push(gh);
      const { user } = await ctx.internalAdapter.createOAuthUser(
        { name: gh, email: `${gh}@example.test`, emailVerified: true, image: null, login: gh } as never,
        { providerId: "github", accountId: `gh-${gh}` } as never,
      );
      await ctx.internalAdapter.createSession(user.id);
      ids.push(user.id);
    }
    const [admin] = ids;
    const seeded = await pipeline([
      ["SADD", "ctf:admin:grants", admin],
      ["HSET", "ctf:admin:grant-gen", admin, 1],
      ["SET", `ctf:admin:code:vt-${RUN}`, "{}", "EX", 600],
      ["SET", `ctf:admin:reset-code:vt-${RUN}`, "{}", "EX", 600],
      ["SADD", "ctf:relink:blocked", `vt-${RUN}`],
      ["SADD", "ctf:admin:claim:spent", spentHash],
      ["LPUSH", "ctf:admin:audit", sentinel],
    ]);
    expect(seeded.filter((r) => r.error)).toEqual([]);
    expect(await isAdminGrantee(admin)).toBe(true);
    expect((await scanAll("ctf:auth:*")).length).toBeGreaterThan(0);
    expect((await scanAll("ctf:link:*")).length).toBeGreaterThan(0);

    // The time a score sync is about to send was judged at: before the reset.
    const judgedAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const actor = { id: admin, name: "organizer" };
    const { cleared } = await deleteAllAccounts("delete all accounts", actor);
    expect(cleared.auth).toBeGreaterThan(0);
    expect(cleared.adminGrantKeys).toBe(2);

    const [grants, gen, spent, audit] = await pipeline([
      ["SCARD", "ctf:admin:grants"],
      ["EXISTS", "ctf:admin:grant-gen"],
      ["SISMEMBER", "ctf:admin:claim:spent", spentHash],
      ["LRANGE", "ctf:admin:audit", 0, -1],
    ]);
    expect(grants.result).toBe(0);
    expect(gen.result).toBe(0);
    expect(await scanAll("ctf:auth:*")).toEqual([]);
    expect(await scanAll("ctf:link:*")).toEqual([]);
    expect(await scanAll("ctf:relink:*")).toEqual([]);
    expect(await scanAll("ctf:admin:code:*")).toEqual([]);
    expect(await scanAll("ctf:admin:reset-code:*")).toEqual([]);
    // The old bootstrap code stays spent.
    expect(spent.result).toBe(1);
    // The audit list keeps its history and gains the reset and this line.
    const lines = (audit.result as string[]).map((l) => JSON.parse(l) as { action: string; by?: string });
    expect(lines.some((l) => l.action === `vt-sentinel-${RUN}`)).toBe(true);
    expect(lines[0]).toMatchObject({ action: "ops:delete-all-accounts", by: admin });
    expect(lines[1]).toMatchObject({ action: "reset", by: admin });
    // The acting admin's cached session no longer opens /admin: requireAdmin
    // reads the grant, and it is gone.
    expect(await isAdminGrantee(admin)).toBe(false);
    for (const id of ids) expect(await ctx.internalAdapter.findUserById(id)).toBeNull();
    // Scores judged before the delete-all and written after it: no hold is
    // set, and the reset epoch the solve script reads in its own EVAL refuses
    // each one with nothing written, with the login, without one, and after
    // the same login linked to the same id again.
    const target = `vtall-${RUN}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
    expect(await scorerSolveWrite(target, ids[1], judgedAt, "late", ghs[1])).toBe("pre-reset");
    expect(await scorerSolveWrite(target, ids[1], judgedAt, "loginless")).toBe("pre-reset");
    const relinked = await pipeline([["SET", `ctf:link:github:${ghs[1]}`, ids[1]]]);
    expect(relinked.filter((r) => r.error)).toEqual([]);
    try {
      expect(await scorerSolveWrite(target, ids[1], judgedAt, "relinked", ghs[1])).toBe("pre-reset");
    } finally {
      await pipeline([["DEL", `ctf:link:github:${ghs[1]}`]]);
    }
    const [late] = await pipeline([["EXISTS", `ctf:solves:${target}`]]);
    expect(late.result).toBe(0);
    // A score timed after the reset epoch whose login link is gone is still
    // the link check's: unlinked, nothing written.
    expect(await scorerSolveWrite(target, ids[1], new Date(Date.now() + 1000).toISOString(), "after", ghs[1])).toBe("unlinked");
  });
});
