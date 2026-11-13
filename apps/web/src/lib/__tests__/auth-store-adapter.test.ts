// The Redis adapter against a mocked `upstashPipeline`: which commands each
// read issues, that a per-command error throws instead of reading as "no
// row", that a reply of the wrong shape throws instead of reading as "no
// rows", that provider tokens are never written, how a taken unique value
// fails a write, how a lost compare-and-set is retried, and how a failed
// transaction deletes the rows it created. What the scripts do to Redis is pinned by the
// live suites.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BetterAuthOptions } from "better-auth";

vi.mock("server-only", () => ({}));

const pipeline = vi.fn();
vi.mock("@/lib/upstash", () => ({ upstashPipeline: (cmds: unknown) => pipeline(cmds) }));

const { redisAdapter } = await import("@/lib/auth-store/redis-adapter");
const { PUT_ROW_SCRIPT } = await import("@/lib/auth-store/scripts");

type Cmd = (string | number)[];

const P = "test:auth";
const adapter = redisAdapter({ prefix: P })({} as BetterAuthOptions);
const w = (field: string, value: string) => ({ field, value });

const sent = (): Cmd[] => pipeline.mock.calls.flatMap(([cmds]) => cmds as Cmd[]);
const names = () => sent().map((c) => c[0]);

// ARGV of the last EVAL, 0-based, after its KEYS.
function evalArgs(): string[] {
  const evals = sent().filter((c) => c[0] === "EVAL");
  const last = evals[evals.length - 1];
  const numKeys = Number(last[2]);
  return last.slice(3 + numKeys).map(String);
}

const session = {
  id: "s1",
  token: "t",
  userId: "u1",
  expiresAt: "2030-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// A scripted Redis: reads answer from `rows`, EVALs from `evalReplies`.
function fakeRedis(rows: Record<string, string>, evalReplies: unknown[] = []) {
  pipeline.mockImplementation(async (cmds: Cmd[]) =>
    cmds.map((c) => {
      switch (c[0]) {
        case "SMEMBERS":
          return { result: Object.keys(rows) };
        case "HMGET":
          return { result: c.slice(2).map((id) => rows[String(id)] ?? null) };
        case "HGET":
          return { result: rows[String(c[2])] ?? null };
        case "HGETALL":
          return { result: Object.entries(rows).flat() };
        case "EVAL":
          return { result: evalReplies.length ? evalReplies.shift() : 1 };
        default:
          return { error: `unexpected ${String(c[0])}` };
      }
    }),
  );
}

beforeEach(() => {
  pipeline.mockReset();
});

describe("redisAdapter (mocked pipeline)", () => {
  it("throws on a per-command error instead of returning null", async () => {
    pipeline.mockResolvedValueOnce([{ error: "NOAUTH Authentication required." }]);
    await expect(adapter.findOne({ model: "session", where: [w("token", "t")] })).rejects.toThrow(
      /auth store: findOne session failed: NOAUTH/,
    );
  });

  it("throws the script's error_reply on a write", async () => {
    pipeline.mockResolvedValueOnce([{ error: "auth store: newJson is not a JSON object" }]);
    await expect(
      adapter.create({ model: "verification", data: { identifier: "i", value: "v", expiresAt: new Date() } }),
    ).rejects.toThrow(/auth store: create verification failed: auth store: newJson is not a JSON object/);
  });

  it("throws on an EVAL reply that is neither 0 nor 1", async () => {
    pipeline.mockResolvedValueOnce([{ result: "OK" }]);
    await expect(
      adapter.create({ model: "verification", data: { identifier: "i", value: "v", expiresAt: new Date() } }),
    ).rejects.toThrow(/auth store: create verification failed/);
  });

  it("never persists provider tokens", async () => {
    fakeRedis({});
    await adapter.create({
      model: "account",
      data: { userId: "u", providerId: "github", accountId: "1", accessToken: "gho_x", refreshToken: "r", idToken: "i" },
    });
    const evalCmd = sent().find((c) => c[0] === "EVAL")!;
    expect(evalCmd[1]).toBe(PUT_ROW_SCRIPT);
    expect(evalArgs()[3]).toBe("");
    const written = JSON.parse(evalArgs()[4]);
    expect([written.accessToken, written.refreshToken, written.idToken]).toEqual([null, null, null]);
    expect(JSON.stringify(sent())).not.toMatch(/gho_x/);
  });

  it("never persists provider tokens on an update either", async () => {
    const account = { id: "a1", userId: "u", providerId: "github", accountId: "1", accessToken: null };
    fakeRedis({ a1: JSON.stringify(account) });
    await adapter.update({ model: "account", where: [w("id", "a1")], update: { accessToken: "gho_y" } });
    expect(JSON.parse(evalArgs()[4]).accessToken).toBeNull();
    expect(JSON.stringify(sent())).not.toMatch(/gho_y/);
  });

  it("uses the token index for a session lookup and HGETALL for an unindexed one", async () => {
    fakeRedis({ s1: JSON.stringify(session) });
    const found = await adapter.findOne<{ id: string }>({ model: "session", where: [w("token", "t")] });
    expect(found?.id).toBe("s1");
    expect(names()).toEqual(["SMEMBERS", "HMGET"]);
    expect(sent()[0]).toEqual(["SMEMBERS", `${P}:session:by:token:t`]);

    pipeline.mockClear();
    await adapter.findMany({ model: "session", where: [{ field: "expiresAt", value: new Date(), operator: "gt" }] });
    expect(names()).toEqual(["HGETALL"]);
    expect(sent()[0]).toEqual(["HGETALL", `${P}:session`]);
  });

  it("filters index hits through the full where clause", async () => {
    fakeRedis({ s1: JSON.stringify(session) });
    const found = await adapter.findOne({
      model: "session",
      where: [w("token", "t"), w("userId", "someone-else")],
    });
    expect(found).toBeNull();
  });

  it("matches a Date-valued where clause against stored ISO strings", async () => {
    const past = { ...session, id: "old", token: "o", expiresAt: new Date(Date.now() - 3_600_000).toISOString() };
    const future = { ...session, id: "new", token: "n", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    fakeRedis({ old: JSON.stringify(past), new: JSON.stringify(future) });
    const rows = await adapter.findMany<{ id: string }>({
      model: "session",
      where: [{ field: "expiresAt", value: new Date(), operator: "lt" }],
    });
    expect(rows.map((r) => r.id)).toEqual(["old"]);
  });

  it("retries a lost compare-and-set and then throws after 3", async () => {
    fakeRedis({ s1: JSON.stringify(session) }, [0, 0, 0, 0]);
    await expect(
      adapter.update({ model: "session", where: [w("id", "s1")], update: { token: "t2" } }),
    ).rejects.toThrow(/auth store: update session failed/);
    expect(names().filter((n) => n === "EVAL")).toHaveLength(4);
  });

  it("wins a compare-and-set on retry against the re-read row", async () => {
    fakeRedis({ s1: JSON.stringify(session) }, [0, 1]);
    const updated = await adapter.update<{ token: string }>({
      model: "session",
      where: [w("id", "s1")],
      update: { token: "t2" },
    });
    expect(updated?.token).toBe("t2");
    expect(names()).toEqual(["HGET", "EVAL", "HGET", "EVAL"]);
  });

  it("drops a row that stopped matching after a lost compare-and-set", async () => {
    const rows: Record<string, string> = { s1: JSON.stringify(session) };
    fakeRedis(rows, [0]);
    const inner = pipeline.getMockImplementation()!;
    pipeline.mockImplementation(async (cmds: Cmd[]) => {
      if (cmds[0][0] === "HGET") rows.s1 = JSON.stringify({ ...session, userId: "moved" });
      return inner(cmds);
    });
    const n = await adapter.deleteMany({ model: "session", where: [w("userId", "u1")] });
    expect(n).toBe(0);
    expect(names().filter((x) => x === "EVAL")).toHaveLength(1);
  });

  it("reads `id eq` with HGET and `id in` with HMGET, never HGETALL", async () => {
    const other = { ...session, id: "s2", token: "u" };
    fakeRedis({ s1: JSON.stringify(session), s2: JSON.stringify(other) });
    const one = await adapter.findOne<{ id: string }>({ model: "session", where: [w("id", "s1")] });
    expect(one?.id).toBe("s1");
    expect(sent()).toEqual([["HGET", `${P}:session`, "s1"]]);

    pipeline.mockClear();
    const many = await adapter.findMany<{ id: string }>({
      model: "session",
      where: [{ field: "id", value: ["s1", "s2", "gone"], operator: "in" }],
    });
    expect(many.map((r) => r.id).sort()).toEqual(["s1", "s2"]);
    expect(sent()).toEqual([["HMGET", `${P}:session`, "s1", "s2", "gone"]]);

    pipeline.mockClear();
    expect(await adapter.findOne({ model: "session", where: [w("id", "s1"), w("userId", "nobody")] })).toBeNull();
    expect(names()).toEqual(["HGET"]);
  });

  it("scans for an `id` clause joined by OR", async () => {
    fakeRedis({ s1: JSON.stringify(session) });
    await adapter.findMany({
      model: "session",
      where: [w("id", "s1"), { field: "token", value: "x", operator: "eq", connector: "OR" }],
    });
    expect(names()).toEqual(["HGETALL"]);
  });

  it("passes the model's unique fields to the write script", async () => {
    fakeRedis({});
    await adapter.create({ model: "user", data: { name: "A", email: "a@x.test", emailVerified: false } });
    expect(evalArgs().slice(5)).toEqual(["email", "email"]);
    pipeline.mockClear();
    await adapter.create({ model: "account", data: { userId: "u", providerId: "github", accountId: "1" } });
    expect(evalArgs().slice(5)).toEqual(["userId,accountId,providerId+accountId", "providerId+accountId"]);
    pipeline.mockClear();
    await adapter.create({ model: "session", data: session });
    expect(evalArgs()[6]).toBe("");
  });

  it("throws on script reply 2 (a unique value held by another row), without retrying", async () => {
    fakeRedis({}, [2]);
    await expect(
      adapter.create({ model: "user", data: { name: "A", email: "a@x.test", emailVerified: false } }),
    ).rejects.toThrow("auth store: create user failed: unique email taken");

    const user = { id: "u1", name: "A", email: "a@x.test", emailVerified: false };
    fakeRedis({ u1: JSON.stringify(user) }, [2]);
    pipeline.mockClear();
    await expect(
      adapter.update({ model: "user", where: [w("id", "u1")], update: { email: "b@x.test" } }),
    ).rejects.toThrow("auth store: update user failed: unique email taken");
    expect(names().filter((n) => n === "EVAL")).toHaveLength(1);
  });

  describe("fails closed on a reply of the wrong shape", () => {
    const byEmail = () => adapter.findOne({ model: "user", where: [w("email", "a@x.test")] });
    const scan = () => adapter.findMany({ model: "user", where: [w("name", "A")] });
    const byId = () => adapter.findOne({ model: "user", where: [w("id", "u1")] });

    it("throws when the pipeline returns fewer replies than commands", async () => {
      pipeline.mockResolvedValueOnce([]);
      await expect(byEmail()).rejects.toThrow(/auth store: findOne user failed: expected 1 replies, got 0/);
    });

    it("throws when the pipeline returns more replies than commands", async () => {
      pipeline.mockResolvedValueOnce([{ result: [] }, { result: [] }]);
      await expect(byEmail()).rejects.toThrow(/expected 1 replies, got 2/);
    });

    it("throws when the pipeline reply is not an array", async () => {
      pipeline.mockResolvedValueOnce(null);
      await expect(byEmail()).rejects.toThrow(/auth store: findOne user failed/);
    });

    it.each([null, "x", 5])("throws on SMEMBERS reply %j", async (bad) => {
      pipeline.mockResolvedValueOnce([{ result: bad }]);
      await expect(byEmail()).rejects.toThrow(/SMEMBERS reply is not an array of strings/);
    });

    it("throws on an HMGET reply shorter than the ids", async () => {
      pipeline.mockResolvedValueOnce([{ result: ["u1", "u2"] }]).mockResolvedValueOnce([{ result: ["{}"] }]);
      await expect(byEmail()).rejects.toThrow(/HMGET reply is not 2 values/);
    });

    it("throws on an HMGET reply that is not an array", async () => {
      pipeline.mockResolvedValueOnce([{ result: ["u1"] }]).mockResolvedValueOnce([{ result: null }]);
      await expect(byEmail()).rejects.toThrow(/HMGET reply is not 1 values/);
    });

    it.each([null, "x", 5])("throws on HGETALL reply %j", async (bad) => {
      pipeline.mockResolvedValueOnce([{ result: bad }]);
      await expect(scan()).rejects.toThrow(/HGETALL reply is/);
    });

    it("throws on an odd-length HGETALL reply", async () => {
      pipeline.mockResolvedValueOnce([{ result: ["u1"] }]);
      await expect(scan()).rejects.toThrow(/HGETALL reply has an odd length/);
    });

    it("reads the object form of HGETALL", async () => {
      const user = { id: "u1", name: "A", email: "a@x.test" };
      pipeline.mockResolvedValueOnce([{ result: { u1: JSON.stringify(user) } }]);
      expect((await scan()).length).toBe(1);
    });

    it("throws on an HGET reply that is neither a string nor null", async () => {
      pipeline.mockResolvedValueOnce([{ result: 5 }]);
      await expect(byId()).rejects.toThrow(/HGET reply is not a string or null/);
    });
  });

  it("trims returned fields to select", async () => {
    fakeRedis({ s1: JSON.stringify(session) });
    const found = await adapter.findOne<Record<string, unknown>>({
      model: "session",
      where: [w("token", "t")],
      select: ["id", "userId"],
    });
    expect(Object.keys(found ?? {}).sort()).toEqual(["id", "userId"]);
  });
});

// A stateful Redis for the transaction tests: rows per hash, index lookups
// answered by scanning the model's rows, a unique email/account key refused
// the way PUT_ROW_SCRIPT refuses it, and `failCreate` turning the next create
// of a model into a per-command error. `loseReply` makes the next create of a
// model land and then throw instead of replying, the way a dropped connection
// after Redis applied the write looks to the caller.
function statefulRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const failCreate = new Set<string>();
  const loseReply = new Set<string>();
  const hash = (key: string) => {
    let h = hashes.get(key);
    if (!h) hashes.set(key, (h = new Map()));
    return h;
  };
  const rowsOf = (model: string) => [...hash(`${P}:${model}`).entries()].map(([id, json]) => [id, JSON.parse(json)] as const);
  pipeline.mockImplementation(async (cmds: Cmd[]) =>
    cmds.map((c) => {
      switch (c[0]) {
        case "SMEMBERS": {
          const [model, , field, ...rest] = String(c[1]).slice(P.length + 1).split(":");
          const value = rest.join(":");
          return { result: rowsOf(model).filter(([, r]) => String(r[field]) === value).map(([id]) => id) };
        }
        case "HMGET":
          return { result: c.slice(2).map((id) => hash(String(c[1])).get(String(id)) ?? null) };
        case "HGET":
          return { result: hash(String(c[1])).get(String(c[2])) ?? null };
        case "HGETALL":
          return { result: [...hash(String(c[1])).entries()].flat() };
        case "EVAL": {
          const [key, , model, id, old] = c.slice(3).map(String);
          const h = hash(key);
          if ((h.get(id) ?? "") !== old) return { result: 0 };
          if (c[1] !== PUT_ROW_SCRIPT) {
            h.delete(id);
            return { result: 1 };
          }
          if (!old && failCreate.delete(model)) return { error: "ERR simulated write failure" };
          const next = JSON.parse(String(c[8]));
          const clash = rowsOf(model).some(
            ([other, r]) =>
              other !== id &&
              ((model === "user" && r.email === next.email) ||
                (model === "account" && r.providerId === next.providerId && r.accountId === next.accountId)),
          );
          if (clash) return { result: 2 };
          h.set(id, String(c[8]));
          if (!old && loseReply.delete(model)) throw new Error("fetch failed");
          return { result: 1 };
        }
        default:
          return { error: `unexpected ${String(c[0])}` };
      }
    }),
  );
  return { failCreate, loseReply, rowsOf, hash };
}

describe("redisAdapter transaction (mocked pipeline)", () => {
  const user = { name: "A", email: "a@x.test", emailVerified: false };
  const account = { providerId: "github", accountId: "42" };
  // A fresh row each time: the factory clears `id` on the object it is handed
  // unless forceAllowId is set, so a shared fixture would lose its id.
  const ownSession = (token = "t") => ({ ...session, id: "s1", token });

  it("deletes the rows the callback created when it throws, and rethrows its error", async () => {
    const redis = statefulRedis();
    const boom = new Error("boom");
    await expect(
      adapter.transaction(async (trx) => {
        await trx.create({ model: "user", data: user });
        await trx.create({ model: "session", data: ownSession(), forceAllowId: true });
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(redis.rowsOf("user")).toEqual([]);
    expect(redis.rowsOf("session")).toEqual([]);
  });

  it("deletes nothing when the callback succeeds", async () => {
    const redis = statefulRedis();
    const out = await adapter.transaction(async (trx) => {
      const u = await trx.create<{ id: string }>({ model: "user", data: user });
      await trx.create({ model: "account", data: { ...account, userId: u.id } });
      return u.id;
    });
    expect(redis.rowsOf("user").map(([id]) => id)).toEqual([out]);
    expect(redis.rowsOf("account")).toHaveLength(1);
    expect(sent().filter((c) => c[0] === "EVAL" && c[1] !== PUT_ROW_SCRIPT)).toEqual([]);
  });

  it("keeps rows that existed before the transaction", async () => {
    const redis = statefulRedis();
    await adapter.create({ model: "user", data: { ...user, email: "kept@x.test" } });
    await expect(
      adapter.transaction(async (trx) => {
        await trx.create({ model: "user", data: user });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(redis.rowsOf("user").map(([, r]) => r.email)).toEqual(["kept@x.test"]);
  });

  it("still undoes the other rows and rethrows the callback's error when one compensating delete fails, logging only the model", async () => {
    const redis = statefulRedis();
    const inner = pipeline.getMockImplementation()!;
    const isUserUndo = (c: Cmd) =>
      (c[0] === "HGET" && c[1] === `${P}:user`) || (c[0] === "EVAL" && c[1] !== PUT_ROW_SCRIPT && c[5] === "user");
    pipeline.mockImplementation(async (cmds: Cmd[]) => (isUserUndo(cmds[0]) ? [{ error: "ERR down" }] : inner(cmds)));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        adapter.transaction(async (trx) => {
          await trx.create({ model: "user", data: user });
          await trx.create({ model: "session", data: ownSession(), forceAllowId: true });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(redis.rowsOf("session")).toEqual([]);
      expect(redis.rowsOf("user")).toHaveLength(1);
      expect(log).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toMatch(/user/);
      expect(logged).not.toMatch(/a@x\.test/);
      expect(logged).not.toContain(redis.rowsOf("user")[0][0]);
    } finally {
      log.mockRestore();
    }
  });

  it("waits for a create still in flight when a parallel one fails, and undoes it", async () => {
    const redis = statefulRedis();
    const inner = pipeline.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    pipeline.mockImplementation(async (cmds: Cmd[]) => {
      const c = cmds[0];
      if (c[0] === "EVAL" && c[1] === PUT_ROW_SCRIPT && c[5] === "user") await gate;
      if (c[0] === "EVAL" && c[1] === PUT_ROW_SCRIPT && c[5] === "account") {
        setTimeout(release, 10);
        return [{ error: "ERR simulated write failure" }];
      }
      return inner(cmds);
    });
    await expect(
      adapter.transaction(async (trx) => {
        await Promise.all([
          trx.create({ model: "user", data: user }),
          trx.create({ model: "account", data: { ...account, userId: "u" } }),
        ]);
      }),
    ).rejects.toThrow(/create account failed/);
    await new Promise((r) => setTimeout(r, 30));
    expect(redis.rowsOf("user")).toEqual([]);
  });

  it("leaves a same-id row someone else wrote after the transaction's own row was deleted", async () => {
    const redis = statefulRedis();
    const theirs = ownSession("theirs");
    await expect(
      adapter.transaction(async (trx) => {
        await trx.create({ model: "session", data: ownSession(), forceAllowId: true });
        await adapter.delete({ model: "session", where: [w("id", "s1")] });
        await adapter.create({ model: "session", data: theirs, forceAllowId: true });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(redis.rowsOf("session").map(([, r]) => r.token)).toEqual(["theirs"]);
  });

  it("undoes a row a nested transaction's unawaited descendant creates after the nested one returned", async () => {
    const redis = statefulRedis();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let descendant!: Promise<unknown>;
    await expect(
      adapter.transaction(async (trx) => {
        await (trx as typeof adapter).transaction(async (nested) => {
          descendant = (nested as typeof adapter).transaction(async (d) => {
            await gate;
            await d.create({ model: "user", data: user });
          });
          setTimeout(release, 10);
        });
        await descendant;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(redis.rowsOf("user")).toEqual([]);
  });

  it("leaves an identical row that was already there when the create is refused", async () => {
    const redis = statefulRedis();
    await adapter.create({ model: "session", data: ownSession(), forceAllowId: true });
    await expect(
      adapter.transaction(async (trx) => {
        await trx.create({ model: "session", data: ownSession(), forceAllowId: true });
      }),
    ).rejects.toThrow(/row s1 already exists/);
    expect(redis.rowsOf("session").map(([id]) => id)).toEqual(["s1"]);
  });

  it("undoes a create whose write landed but whose reply was lost", async () => {
    const redis = statefulRedis();
    await expect(
      adapter.transaction(async (trx) => {
        redis.loseReply.add("session");
        await trx.create({ model: "session", data: ownSession(), forceAllowId: true });
      }),
    ).rejects.toThrow(/create session failed: fetch failed/);
    expect(redis.rowsOf("session")).toEqual([]);
  });

  it("keeps one transaction's rollback from touching a concurrent one's rows", async () => {
    const redis = statefulRedis();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ok = adapter.transaction(async (trx) => {
      await trx.create({ model: "user", data: { ...user, email: "ok@x.test" } });
      await gate;
    });
    await expect(
      adapter.transaction(async (trx) => {
        await trx.create({ model: "user", data: user });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    release();
    await ok;
    expect(redis.rowsOf("user").map(([, r]) => r.email)).toEqual(["ok@x.test"]);
  });

  it("rolls back a nested transaction's rows when the outer one fails", async () => {
    const redis = statefulRedis();
    await expect(
      adapter.transaction(async (trx) => {
        await (trx as typeof adapter).transaction(async (inner) => {
          await inner.create({ model: "user", data: user });
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(redis.rowsOf("user")).toEqual([]);
  });

  describe("createOAuthUser", () => {
    async function internalAdapter() {
      const { betterAuth } = await import("better-auth");
      const instance = betterAuth({
        baseURL: "http://localhost:3000",
        secret: "0123456789abcdef0123456789abcdef",
        database: redisAdapter({ prefix: P }),
        account: { accountLinking: { disableImplicitLinking: true } },
      });
      return (await instance.$context).internalAdapter;
    }

    it("leaves no user row when the account write fails, so a retried sign-in succeeds", async () => {
      const redis = statefulRedis();
      const ia = await internalAdapter();
      redis.failCreate.add("account");
      await expect(ia.createOAuthUser(user, account)).rejects.toThrow(/auth store: create account failed: ERR simulated write failure/);
      expect(redis.rowsOf("user")).toEqual([]);
      expect(redis.rowsOf("account")).toEqual([]);
      expect(await ia.findUserByEmail(user.email)).toBeNull();

      const { user: created, account: linked } = await ia.createOAuthUser(user, account);
      expect(linked?.userId).toBe(created.id);
      expect(redis.rowsOf("user").map(([id]) => id)).toEqual([created.id]);
      expect((await ia.findAccountByKey(account))?.userId).toBe(created.id);
    });

    it("leaves no account behind when the account write landed but its reply was lost", async () => {
      const redis = statefulRedis();
      const ia = await internalAdapter();
      redis.loseReply.add("account");
      await expect(ia.createOAuthUser(user, account)).rejects.toThrow(/auth store: create account failed: fetch failed/);
      expect(redis.rowsOf("user")).toEqual([]);
      expect(redis.rowsOf("account")).toEqual([]);

      const { user: created, account: linked } = await ia.createOAuthUser(user, account);
      expect(linked?.userId).toBe(created.id);
      expect(redis.rowsOf("account").map(([, r]) => r.userId)).toEqual([created.id]);
    });
  });
});
