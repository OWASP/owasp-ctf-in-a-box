// The Redis adapter end to end through better-auth's adapter factory against
// a real Redis behind srh: the factory's date serialization, the index sets
// the scripts maintain, and Date-valued where clauses (better-auth sweeps
// expired sessions and verifications with `expiresAt lt now`) are only
// observable here.

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { indexKey } from "@/lib/auth-store/keys";
import { upstashPipeline } from "@/lib/upstash";
import { freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

type Adapter = ReturnType<ReturnType<(typeof import("@/lib/auth-store/redis-adapter"))["redisAdapter"]>>;
type Row = { id: string; expiresAt: Date; accessToken?: unknown };

describe.skipIf(!liveConfigured)("redisAdapter against a live SRH proxy", () => {
  let make: (typeof import("@/lib/auth-store/redis-adapter"))["redisAdapter"];

  beforeAll(async () => {
    ({ redisAdapter: make } = await import("@/lib/auth-store/redis-adapter"));
  });

  const fresh = (): Adapter => make({ prefix: liveKey("auth-adapter", freshId("p")) })({} as BetterAuthOptions);
  const freshWithPrefix = () => {
    const prefix = liveKey("auth-adapter", freshId("p"));
    return { prefix, adapter: make({ prefix })({} as BetterAuthOptions) };
  };
  async function smembers(key: string): Promise<string[]> {
    const [res] = await upstashPipeline([["SMEMBERS", key]]);
    if (res.error) throw new Error(res.error);
    return res.result as string[];
  }

  async function makeUser(adapter: Adapter) {
    return adapter.create<Record<string, unknown>, Row>({
      model: "user",
      data: { name: "Ada", email: `${freshId("ada")}@example.test`, emailVerified: false },
    });
  }

  it("round-trips user, account and session", async () => {
    const adapter = fresh();
    const user = await makeUser(adapter);

    const account = await adapter.create<Record<string, unknown>, Row>({
      model: "account",
      data: { userId: user.id, providerId: "github", accountId: "42", accessToken: "gho_secret" },
    });
    const storedAccount = await adapter.findOne<Row>({ model: "account", where: [{ field: "id", value: account.id }] });
    expect(storedAccount?.accessToken).toBeNull();

    const expiresAt = new Date(Date.now() + 3_600_000);
    const created = await adapter.create<Record<string, unknown>, Row>({
      model: "session",
      data: { userId: user.id, token: "tok-1", expiresAt },
    });

    const byToken = await adapter.findOne<Row>({ model: "session", where: [{ field: "token", value: "tok-1" }] });
    expect(byToken?.id).toBe(created.id);
    expect(byToken?.expiresAt).toBeInstanceOf(Date);
    expect(byToken?.expiresAt.getTime()).toBe(expiresAt.getTime());

    const later = new Date(expiresAt.getTime() + 60_000);
    const updated = await adapter.update<Row>({
      model: "session",
      where: [{ field: "id", value: created.id }],
      update: { expiresAt: later },
    });
    expect(updated?.expiresAt.getTime()).toBe(later.getTime());

    const mine = await adapter.findMany<Row>({ model: "session", where: [{ field: "userId", value: user.id }] });
    expect(mine.map((s) => s.id)).toEqual([created.id]);
    expect(mine[0].expiresAt.getTime()).toBe(later.getTime());

    expect(await adapter.deleteMany({ model: "session", where: [{ field: "userId", value: user.id }] })).toBe(1);
    expect(await adapter.count({ model: "session" })).toBe(0);
    expect(await adapter.findOne({ model: "session", where: [{ field: "token", value: "tok-1" }] })).toBeNull();
  });

  it("matches a Date-valued expiresAt clause against stored rows", async () => {
    const adapter = fresh();
    const user = await makeUser(adapter);
    const past = await adapter.create<Record<string, unknown>, Row>({
      model: "session",
      data: { userId: user.id, token: "past", expiresAt: new Date(Date.now() - 3_600_000) },
    });
    await adapter.create({
      model: "session",
      data: { userId: user.id, token: "future", expiresAt: new Date(Date.now() + 3_600_000) },
    });

    const expired = [{ field: "expiresAt", value: new Date(), operator: "lt" as const }];
    const found = await adapter.findMany<Row>({ model: "session", where: expired });
    expect(found.map((s) => s.id)).toEqual([past.id]);

    expect(await adapter.deleteMany({ model: "session", where: expired })).toBe(1);
    const left = await adapter.findMany<{ token: string }>({ model: "session", where: [] });
    expect(left.map((s) => s.token)).toEqual(["future"]);
  });

  it("consumes a verification exactly once", async () => {
    const adapter = fresh();
    await adapter.create({
      model: "verification",
      data: { identifier: "state-1", value: "v", expiresAt: new Date(Date.now() + 60_000) },
    });
    const where = [{ field: "identifier", value: "state-1" }];
    const [a, b] = await Promise.all([
      adapter.consumeOne({ model: "verification", where }),
      adapter.consumeOne({ model: "verification", where }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await adapter.count({ model: "verification" })).toBe(0);
  });

  it("sorts, pages and counts with a where clause", async () => {
    const adapter = fresh();
    const user = await makeUser(adapter);
    for (const n of [3, 1, 2]) {
      await adapter.create({
        model: "session",
        data: { userId: user.id, token: `t${n}`, expiresAt: new Date(Date.now() + n * 60_000) },
      });
    }
    const page = await adapter.findMany<{ token: string }>({
      model: "session",
      where: [{ field: "userId", value: user.id }],
      sortBy: { field: "expiresAt", direction: "desc" },
      limit: 2,
      offset: 1,
    });
    expect(page.map((s) => s.token)).toEqual(["t2", "t1"]);
    expect(await adapter.count({ model: "session", where: [{ field: "userId", value: user.id }] })).toBe(3);
  });

  it("lets exactly one of two concurrent users with the same email be created", async () => {
    const { prefix, adapter } = freshWithPrefix();
    const data = { name: "Ada", email: "same@example.test", emailVerified: false };
    const results = await Promise.allSettled([
      adapter.create<Record<string, unknown>, Row>({ model: "user", data }),
      adapter.create<Record<string, unknown>, Row>({ model: "user", data }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/auth store: create user failed: unique email taken/);
    const won = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Row>).value;
    expect(await adapter.count({ model: "user" })).toBe(1);
    expect(await smembers(indexKey(prefix, "user", "email", "same@example.test"))).toEqual([won.id]);
  });

  it("lets exactly one of two concurrent accounts with the same provider and accountId be created", async () => {
    const { prefix, adapter } = freshWithPrefix();
    const results = await Promise.allSettled(
      ["u1", "u2"].map((userId) =>
        adapter.create<Record<string, unknown>, Row>({
          model: "account",
          data: { userId, providerId: "github", accountId: "42" },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/auth store: create account failed: unique providerId\+accountId taken/);
    const won = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Row>).value;
    expect(await adapter.count({ model: "account" })).toBe(1);
    expect(await smembers(indexKey(prefix, "account", "providerId+accountId", "github:42"))).toEqual([won.id]);
  });

  it("refuses an update to an email another user holds, leaving both rows unchanged", async () => {
    const adapter = fresh();
    const a = await makeUser(adapter);
    const b = await makeUser(adapter);
    const before = await adapter.findMany({ model: "user", where: [{ field: "id", value: [a.id, b.id], operator: "in" }] });
    await expect(
      adapter.update({ model: "user", where: [{ field: "id", value: b.id }], update: { email: (a as { email?: string }).email } }),
    ).rejects.toThrow(/auth store: update user failed: unique email taken/);
    const after = await adapter.findMany({ model: "user", where: [{ field: "id", value: [a.id, b.id], operator: "in" }] });
    expect(after).toHaveLength(2);
    expect(after).toEqual(before);
  });
});
