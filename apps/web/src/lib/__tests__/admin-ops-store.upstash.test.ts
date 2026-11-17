// Executes RESET_MODULE_SOLVES_SCRIPT — a contestant's classic progress
// reset — against a real Redis via SRH, on run-unique keys. The mocked
// admin-ops-store suite pins which keys `resetUserProgress` hands the script;
// this one pins what the script does with them: this login's rows and totals
// go, nobody else's do, and each solved challenge's solve count drops by one.
// See live-redis.ts for the harness.

import { afterAll, describe, expect, it, vi } from "vitest";
import { RUN, freshId, liveConfigured, liveKey } from "./live-redis";
import { destructiveLiveRedisAllowed } from "./live-redis-guard";

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
    await pipeline([["HSET", `ctf:user:${id}`, "firstTeamAt", at]]);
    const actor = { id: crypto.randomUUID(), name: "organizer" };

    const spy = vi.spyOn(ctx.internalAdapter, "deleteAccounts").mockRejectedValueOnce(new Error("auth store: down"));
    try {
      await expect(ops.deleteUser(id, actor)).rejects.toThrow("auth store: down");
    } finally {
      spy.mockRestore();
    }
    // The event record and the link went before the failure; the account did not.
    const [record] = await pipeline([["EXISTS", `ctf:user:${id}`]]);
    expect(record.result).toBe(0);
    expect((await authState(id)).user).toMatchObject({ id });

    await expect(ops.deleteUser(id, actor)).resolves.toMatchObject({ leftTeam: null });
    expect(await authState(id)).toEqual({ user: null, accounts: 0, sessions: 0 });
    const [blocked] = await pipeline([["SISMEMBER", "ctf:relink:blocked", gh]]);
    expect(blocked.result).toBe(1);
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
  let settings: string[] = [];
  let pauses: string[] = [];

  afterAll(async () => {
    if (!pipeline) return;
    await pipeline([
      ["LREM", "ctf:admin:audit", 0, sentinel],
      ["SREM", "ctf:admin:claim:spent", spentHash],
      ["DEL", "ctf:admin:settings", "ctf:admin:pauses"],
      ...(settings.length ? [["HSET", "ctf:admin:settings", ...settings]] : []),
      ...(pauses.length ? [["RPUSH", "ctf:admin:pauses", ...pauses]] : []),
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
    settings = (snapSettings.result as string[] | null) ?? [];
    pauses = (snapPauses.result as string[] | null) ?? [];

    const ids: string[] = [];
    for (const n of [1, 2]) {
      const gh = `vtall${n}${RUN.replace(/[^a-z0-9]/g, "")}`.slice(0, 39);
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
  });
});
