// Live-Redis tests for the Redis user store's compare-and-set row scripts:
// what they do to the rows hash and the index sets is only observable against
// a real Redis. Index keys are asserted through `indexKey` so a format drift
// between the Lua and keys.ts fails here.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { indexKey, rowsKey } from "@/lib/auth-store/keys";
import { freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

describe.skipIf(!liveConfigured)("auth-store row scripts against a live SRH proxy", () => {
  let PUT_ROW_SCRIPT: string;
  let DEL_ROW_SCRIPT: string;
  let upstashEval: (typeof import("@/lib/upstash"))["upstashEval"];
  let upstashPipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  beforeAll(async () => {
    ({ PUT_ROW_SCRIPT, DEL_ROW_SCRIPT } = await import("@/lib/auth-store/scripts"));
    ({ upstashEval, upstashPipeline } = await import("@/lib/upstash"));
  });

  const json = (r: Row) => JSON.stringify(r);
  const csvFor = (model: string) =>
    ({ user: "email", session: "token,userId", account: "userId,accountId,providerId+accountId" })[model] ?? "";
  const uniqueFor = (model: string) => ({ user: "email", account: "providerId+accountId" })[model] ?? "";

  // Each test gets its own prefix so index sets never collide.
  function ctx(model: string) {
    const P = liveKey("auth-scripts", freshId("p"));
    const put = async (expected: string, row: Row) =>
      upstashEval(PUT_ROW_SCRIPT, [rowsKey(P, model)], [P, model, String(row.id), expected, json(row), csvFor(model), uniqueFor(model)]);
    const del = async (id: string, expected: string) =>
      upstashEval(DEL_ROW_SCRIPT, [rowsKey(P, model)], [P, model, id, expected, csvFor(model)]);
    const smembers = async (key: string) => {
      const [res] = await upstashPipeline([["SMEMBERS", key]]);
      if (res.error) throw new Error(res.error);
      return res.result as string[];
    };
    const hget = async (id: string) => {
      const [res] = await upstashPipeline([["HGET", rowsKey(P, model), id]]);
      if (res.error) throw new Error(res.error);
      return res.result as string | null;
    };
    return { P, put, del, smembers, hget };
  }

  it("creates only when absent", async () => {
    const { put, hget } = ctx("session");
    const row1 = { id: "s1", token: "a", userId: "u1" };
    expect(await put("", row1)).toBe(1);
    expect(await put("", { ...row1, token: "z" })).toBe(0);
    expect(await hget("s1")).toBe(json(row1));
  });

  it("updates only against the snapshot it read, and moves index entries", async () => {
    const { P, put, smembers } = ctx("session");
    const first = { id: "s1", token: "a", userId: "u1" };
    await put("", first);
    expect(await smembers(indexKey(P, "session", "token", "a"))).toEqual(["s1"]);
    expect(await put(json({ id: "s1", token: "STALE", userId: "u1" }), { id: "s1", token: "c", userId: "u1" })).toBe(0);
    expect(await put(json(first), { id: "s1", token: "b", userId: "u1" })).toBe(1);
    expect(await smembers(indexKey(P, "session", "token", "a"))).toEqual([]);
    expect(await smembers(indexKey(P, "session", "token", "b"))).toEqual(["s1"]);
    expect(await smembers(indexKey(P, "session", "userId", "u1"))).toEqual(["s1"]);
  });

  it("lets exactly one of two concurrent updates from the same snapshot win", async () => {
    const { put, hget } = ctx("session");
    const base = { id: "s1", token: "a", userId: "u1" };
    await put("", base);
    const snap = json(base);
    const results = await Promise.all([
      put(snap, { id: "s1", token: "A", userId: "u1" }),
      put(snap, { id: "s1", token: "B", userId: "u1" }),
    ]);
    expect((results as number[]).sort()).toEqual([0, 1]);
    expect(["A", "B"]).toContain((JSON.parse((await hget("s1"))!) as Row).token);
  });

  it("deletes only against the snapshot, with its index entries", async () => {
    const { P, put, del, smembers, hget } = ctx("session");
    const row = { id: "s1", token: "a", userId: "u1" };
    await put("", row);
    expect(await del("s1", json({ ...row, token: "STALE" }))).toBe(0);
    expect(await hget("s1")).toBe(json(row));
    expect(await del("s1", json(row))).toBe(1);
    expect(await hget("s1")).toBeNull();
    expect(await smembers(indexKey(P, "session", "token", "a"))).toEqual([]);
    expect(await smembers(indexKey(P, "session", "userId", "u1"))).toEqual([]);
    expect(await del("s1", json(row))).toBe(0);
  });

  it("leaves a field that is null or absent out of every index", async () => {
    const { P, put, smembers } = ctx("user");
    expect(await put("", { id: "u1", email: null })).toBe(1);
    expect(await put("", { id: "u2" })).toBe(1);
    expect(await smembers(indexKey(P, "user", "email", ""))).toEqual([]);
    expect(await smembers(indexKey(P, "user", "email", "null"))).toEqual([]);
  });

  it("lets exactly one of two concurrent creates with the same email win", async () => {
    const { P, put, hget, smembers } = ctx("user");
    const results = await Promise.all([
      put("", { id: "u1", email: "same@x.test" }),
      put("", { id: "u2", email: "same@x.test" }),
    ]);
    expect([...(results as number[])].sort()).toEqual([1, 2]);
    const winner = results[0] === 1 ? "u1" : "u2";
    const loser = winner === "u1" ? "u2" : "u1";
    expect(await hget(loser)).toBeNull();
    expect(await smembers(indexKey(P, "user", "email", "same@x.test"))).toEqual([winner]);
  });

  it("lets exactly one of two concurrent accounts with the same provider and accountId win", async () => {
    const { P, put, hget, smembers } = ctx("account");
    const results = await Promise.all([
      put("", { id: "a1", userId: "u1", providerId: "github", accountId: "42" }),
      put("", { id: "a2", userId: "u2", providerId: "github", accountId: "42" }),
    ]);
    expect([...(results as number[])].sort()).toEqual([1, 2]);
    const winner = results[0] === 1 ? "a1" : "a2";
    expect(await hget(winner === "a1" ? "a2" : "a1")).toBeNull();
    expect(await smembers(indexKey(P, "account", "providerId+accountId", "github:42"))).toEqual([winner]);
    expect(await smembers(indexKey(P, "account", "accountId", "42"))).toEqual([winner]);
  });

  it("allows the same accountId under another provider", async () => {
    const { put } = ctx("account");
    expect(await put("", { id: "a1", userId: "u1", providerId: "github", accountId: "42" })).toBe(1);
    expect(await put("", { id: "a2", userId: "u2", providerId: "gitlab", accountId: "42" })).toBe(1);
  });

  it("refuses an update to an email another row holds, and changes neither row", async () => {
    const { P, put, hget, smembers } = ctx("user");
    const a = { id: "u1", email: "a@x.test" };
    const b = { id: "u2", email: "b@x.test" };
    await put("", a);
    await put("", b);
    expect(await put(json(b), { id: "u2", email: "a@x.test" })).toBe(2);
    expect(await hget("u1")).toBe(json(a));
    expect(await hget("u2")).toBe(json(b));
    expect(await smembers(indexKey(P, "user", "email", "a@x.test"))).toEqual(["u1"]);
    expect(await smembers(indexKey(P, "user", "email", "b@x.test"))).toEqual(["u2"]);
    // Keeping its own value is not a conflict.
    expect(await put(json(b), { id: "u2", email: "b@x.test", name: "B" })).toBe(1);
  });

  it("ignores a stale index member whose row is gone", async () => {
    const { P, put } = ctx("user");
    const [res] = await upstashPipeline([["SADD", indexKey(P, "user", "email", "x@x.test"), "ghost"]]);
    expect(res.error).toBeUndefined();
    expect(await put("", { id: "u1", email: "x@x.test" })).toBe(1);
  });

  it("drops the composite index entry on delete", async () => {
    const { P, put, del, smembers } = ctx("account");
    const row = { id: "a1", userId: "u1", providerId: "github", accountId: "42" };
    await put("", row);
    expect(await del("a1", json(row))).toBe(1);
    expect(await smembers(indexKey(P, "account", "providerId+accountId", "github:42"))).toEqual([]);
  });

  it.each(["not json", "null", "5"])("rejects the payload %j before any write", async (bad) => {
    const { P, put, smembers, hget } = ctx("session");
    const row = { id: "s1", token: "a", userId: "u1" };
    await put("", row);
    const [res] = await upstashPipeline([
      ["EVAL", PUT_ROW_SCRIPT, 1, rowsKey(P, "session"), P, "session", "s1", json(row), bad, "token,userId"],
    ]);
    expect(res.error).toMatch(/newJson is not a JSON object/);
    expect(await hget("s1")).toBe(json(row));
    expect(await smembers(indexKey(P, "session", "token", "a"))).toEqual(["s1"]);
    expect(await smembers(indexKey(P, "session", "userId", "u1"))).toEqual(["s1"]);
  });
});
