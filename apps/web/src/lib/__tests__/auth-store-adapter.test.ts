// The Redis adapter against a mocked `upstashPipeline`: which commands each
// read issues, that a per-command error throws instead of reading as "no
// row", that provider tokens are never written, and how a lost
// compare-and-set is retried. What the scripts do to Redis is pinned by the
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
    expect(names()).toEqual(["HGETALL", "EVAL", "HGET", "EVAL"]);
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
