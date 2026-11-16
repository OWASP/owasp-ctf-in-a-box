// setUsernameOnce over the real Redis store behind SRH: the unique index
// decides between two users picking one name, and the compare-and-set's
// re-checked `username = null` clause between two picks for one user.

import { describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { authOptions } from "@/lib/auth";
import { redisAdapter } from "@/lib/auth-store/redis-adapter";
import { freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

vi.hoisted(() => {
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.GITHUB_CLIENT_ID ??= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";
});

// setUsernameOnce reads `auth`; point it at a suite-scoped prefix.
const live = vi.hoisted(() => ({ instance: null as null | { $context: Promise<unknown> } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    auth: {
      get $context() {
        return live.instance!.$context;
      },
    },
  };
});

import { setUsernameOnce } from "@/lib/username-store";

async function freshUser(prefix: string, login: string) {
  const instance = betterAuth({ ...authOptions, database: redisAdapter({ prefix }) });
  live.instance = instance;
  const ctx = await instance.$context;
  return ctx.internalAdapter.createOAuthUser(
    { name: login, email: `${login}@example.test`, emailVerified: true, image: null, login } as never,
    { providerId: "github", accountId: `acct-${login}-${freshId("a")}` } as never,
  );
}

describe.skipIf(!liveConfigured)("setUsernameOnce against a live SRH proxy", () => {
  it("answers taken, leaving no username, when another user already holds it", async () => {
    const prefix = liveKey("username-store", freshId("held"));
    const a = await freshUser(prefix, "held-a");
    const b = await freshUser(prefix, "held-b");
    expect(await setUsernameOnce(a.user.id, "bob")).toBe("ok");
    expect(await setUsernameOnce(b.user.id, "Bob")).toBe("taken");

    const ctx = (await live.instance!.$context) as Awaited<ReturnType<typeof betterAuth>["$context"]>;
    const row = (await ctx.internalAdapter.findUserById(b.user.id)) as { username?: string | null };
    expect(row.username ?? null).toBeNull();
  });

  it("lets exactly one of two concurrent picks of Bob and bob win", async () => {
    const prefix = liveKey("username-store", freshId("race"));
    const a = await freshUser(prefix, "one");
    const b = await freshUser(prefix, "two");
    const results = await Promise.all([setUsernameOnce(a.user.id, "Bob"), setUsernameOnce(b.user.id, "bob")]);
    expect([...results].sort()).toEqual(["ok", "taken"]);

    const ctx = (await live.instance!.$context) as Awaited<ReturnType<typeof betterAuth>["$context"]>;
    const rows = await Promise.all([a.user.id, b.user.id].map((id) => ctx.internalAdapter.findUserById(id)));
    const winner = rows[results.indexOf("ok")] as { username?: string; displayUsername?: string };
    expect(winner.username).toBe("bob");
    expect(["Bob", "bob"]).toContain(winner.displayUsername);
    const loser = rows[results.indexOf("taken")] as { username?: string | null };
    expect(loser.username ?? null).toBeNull();
  });

  it("is idempotent in the already_set direction and keeps the stored name", async () => {
    const prefix = liveKey("username-store", freshId("set"));
    const u = await freshUser(prefix, "solo");
    expect(await setUsernameOnce(u.user.id, "Carol_9")).toBe("ok");
    expect(await setUsernameOnce(u.user.id, "other")).toBe("already_set");
    const ctx = (await live.instance!.$context) as Awaited<ReturnType<typeof betterAuth>["$context"]>;
    const row = (await ctx.internalAdapter.findUserById(u.user.id)) as { username?: string; displayUsername?: string };
    expect(row.username).toBe("carol_9");
    expect(row.displayUsername).toBe("Carol_9");
  });

  it("lets exactly one of two concurrent picks for ONE user win, never overwriting it", async () => {
    const prefix = liveKey("username-store", freshId("once"));
    const u = await freshUser(prefix, "twotabs");
    const results = await Promise.all([setUsernameOnce(u.user.id, "Alice"), setUsernameOnce(u.user.id, "Bob")]);
    expect([...results].sort()).toEqual(["already_set", "ok"]);

    const ctx = (await live.instance!.$context) as Awaited<ReturnType<typeof betterAuth>["$context"]>;
    const row = (await ctx.internalAdapter.findUserById(u.user.id)) as { username?: string; displayUsername?: string };
    const won = results[0] === "ok" ? ["alice", "Alice"] : ["bob", "Bob"];
    expect([row.username, row.displayUsername]).toEqual(won);
  });
});
