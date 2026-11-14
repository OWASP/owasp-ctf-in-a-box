// better-auth's own internal adapter driven over the Redis store against a
// real Redis behind srh: the calls the GitHub callback, getSession and
// sign-out make (account-owner lookup with its user join, the session join,
// the verification cleanup sweep) reach the adapter only in shapes better-auth
// builds, so they are pinned here rather than by hand-written where clauses.
// The instance is the app's real config with only `database` swapped for a
// suite-scoped prefix.

import { afterAll, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { handleOAuthUserInfo, linkOAuthAccount } from "better-auth/oauth2";
import { authOptions } from "@/lib/auth";
import * as keys from "@/lib/auth-store/keys";
import { LINK_AT_KEY, LINK_USER_PREFIX, linkKey } from "@/lib/github-link";
import { redisAdapter } from "@/lib/auth-store/redis-adapter";
import { upstashPipeline as pipeline } from "@/lib/upstash";
import { freshId, liveConfigured, liveKey, RUN } from "./live-redis";

vi.mock("server-only", () => ({}));

// Every pipeline goes to the real SRH; a test can set `relay.hook` to sit in
// front of it, e.g. to run a command and then drop its reply.
type Pipeline = typeof import("@/lib/upstash").upstashPipeline;
const relay = vi.hoisted(() => ({
  hook: null as null | ((cmds: (string | number)[][], real: (cmds: (string | number)[][]) => Promise<unknown>) => Promise<unknown>),
}));
vi.mock("@/lib/upstash", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/upstash")>();
  const upstashPipeline: Pipeline = (cmds, opts) =>
    (relay.hook ? relay.hook(cmds, (c) => real.upstashPipeline(c, opts)) : real.upstashPipeline(cmds, opts)) as ReturnType<Pipeline>;
  return { ...real, upstashPipeline };
});

// auth.ts builds its own instance at import; vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.GITHUB_CLIENT_ID ??= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";
});

type User = { id: string; email: string; login?: string };

type LinkInput = { userId: string; kitEmail: string; accountId: string; login: string; ghEmail: string };
type LinkResult = { linked: boolean; error?: { code: string } };

// The link half of GitHub's callback, mounted at the callback's own route so
// the user-update hooks see the endpoint context a real link runs under.
// Test-only: the token exchange in front of it needs GitHub.
const linkProbe = {
  id: "link-probe",
  endpoints: {
    linkProbe: createAuthEndpoint("/callback/:id", { method: "POST" }, async (c) => {
      const b = c.body as LinkInput;
      return c.json(
        await linkOAuthAccount(c, {
          link: { userId: b.userId, email: b.kitEmail },
          userInfo: {
            id: b.accountId,
            email: b.ghEmail,
            emailVerified: true,
            name: "GitHub Name",
            image: "https://avatars.example.test/gh.png",
            login: b.login,
          } as Parameters<typeof linkOAuthAccount>[1]["userInfo"],
          account: { providerId: "github", accountId: b.accountId },
          profile: {},
        }),
      );
    }),
  },
};

async function build() {
  const prefix = liveKey("auth-better-auth", freshId("p"));
  const instance = betterAuth({ ...authOptions, database: redisAdapter({ prefix }), plugins: [linkProbe] });
  // The probe declares no body schema, so its typed input is `undefined`.
  const probe = instance.api.linkProbe as unknown as (input: { body: LinkInput }) => Promise<LinkResult>;
  const link = (body: LinkInput) => probe({ body });
  return { prefix, instance, ctx: await instance.$context, link };
}

// A signed session cookie for `userId`, as the browser would send it.
async function sessionHeaders(ctx: Awaited<ReturnType<typeof build>>["ctx"], userId: string): Promise<Headers> {
  const { token } = await ctx.internalAdapter.createSession(userId);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(ctx.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, enc.encode(token))).toString("base64");
  return new Headers({ cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${sig}`)}` });
}

describe.skipIf(!liveConfigured)("better-auth over the Redis store against a live SRH proxy", () => {
  async function redis(cmd: (string | number)[]): Promise<unknown> {
    const [res] = await pipeline([cmd]);
    if (res.error) throw new Error(res.error);
    return res.result;
  }

  const profile = (login: string) => ({
    name: "Octo Cat",
    email: `${login}@example.test`,
    emailVerified: true,
    image: null,
    login,
  });
  const githubAccount = (accountId: string) => ({ providerId: "github", accountId, accessToken: "gho_secret" });

  it("signs in, reads the session, follows a rename, consumes state, and signs out", async () => {
    const { prefix, ctx } = await build();
    const ia = ctx.internalAdapter;

    const { user, account } = await ia.createOAuthUser(profile("octo"), githubAccount("4242"));
    expect(account?.userId).toBe(user.id);

    // The callback's lookup: providerId + accountId, joined to its user.
    const owner = await ia.findAccountOwnerByKey({ providerId: "github", accountId: "4242" });
    expect(owner?.kind).toBe("owned");
    expect(owner && "user" in owner ? (owner.user as User).id : null).toBe(user.id);
    expect((await ia.findAccountByKey({ providerId: "github", accountId: "4242" }))?.userId).toBe(user.id);
    expect((await ia.findUserByEmail("OCTO@example.test"))?.user.id).toBe(user.id);
    expect((await ia.findAccounts(user.id)).map((a) => a.accessToken ?? null)).toEqual([null]);
    const storedAccount = (await redis(["HGET", keys.rowsKey(prefix, "account"), account!.id])) as string;
    expect(storedAccount).not.toMatch(/gho_secret/);

    const session = await ia.createSession(user.id);
    const found = await ia.findSession(session.token);
    expect(found?.session.id).toBe(session.id);
    expect((found?.user as User | undefined)?.login).toBe("octo");

    // overrideUserInfoOnSignIn: the next sign-in rewrites `login` by user id.
    await ia.updateUser(user.id, { login: "octo-renamed" });
    expect(((await ia.findSession(session.token))?.user as User | undefined)?.login).toBe("octo-renamed");

    // OAuth state: written at /sign-in/social, read and dropped at the callback.
    await ia.createVerificationValue({ identifier: "state-old", value: "x", expiresAt: new Date(Date.now() - 60_000) });
    await ia.createVerificationValue({ identifier: "state-1", value: "v1", expiresAt: new Date(Date.now() + 600_000) });
    expect((await ia.findVerificationValue("state-1"))?.value).toBe("v1");
    // findVerificationValue sweeps expired rows as it reads.
    expect(await ctx.adapter.count({ model: "verification" })).toBe(1);
    await ia.deleteVerificationByIdentifier("state-1");
    expect(await ia.findVerificationValue("state-1")).toBeNull();
    expect(await ctx.adapter.count({ model: "verification" })).toBe(0);

    await ia.deleteSession(session.token);
    expect(await ia.findSession(session.token)).toBeNull();
    expect(await redis(["HLEN", keys.rowsKey(prefix, "session")])).toBe(0);
    expect(await redis(["SMEMBERS", keys.indexKey(prefix, "session", "token", session.token)])).toEqual([]);
    expect(await redis(["SMEMBERS", keys.indexKey(prefix, "session", "userId", user.id)])).toEqual([]);
  });

  it("leaves exactly one user and one account after two concurrent first sign-ins", async () => {
    const { ctx } = await build();
    const ia = ctx.internalAdapter;
    const results = await Promise.allSettled([
      ia.createOAuthUser(profile("racer"), githubAccount("777")),
      ia.createOAuthUser(profile("racer"), githubAccount("777")),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await ctx.adapter.count({ model: "user" })).toBe(1);
    expect(await ctx.adapter.count({ model: "account" })).toBe(1);
    // The lookup that throws on duplicates keeps working.
    const owner = await ia.findAccountOwnerByKey({ providerId: "github", accountId: "777" });
    expect(owner?.kind).toBe("owned");
  });

  it("refuses a second account for the same GitHub identity under another user", async () => {
    const { ctx } = await build();
    const ia = ctx.internalAdapter;
    const first = await ia.createOAuthUser(profile("one"), githubAccount("888"));
    const { user: other } = await ia.createOAuthUser(profile("two"), githubAccount("999"));
    await expect(ia.linkAccount({ ...githubAccount("888"), userId: other.id })).rejects.toThrow(
      /unique providerId\+accountId taken/,
    );
    const owner = await ia.findAccountOwnerByKey({ providerId: "github", accountId: "888" });
    expect(owner && "user" in owner ? (owner.user as User).id : null).toBe(first.user.id);
  });

  it("does not put a second GitHub identity with the same verified email on the first user", async () => {
    const { ctx } = await build();
    const ia = ctx.internalAdapter;
    const first = await ia.createOAuthUser(profile("mover"), githubAccount("1001"));

    // The callback's own decision, with the email the first account holds now
    // reported verified for a different GitHub account id.
    const c = { context: ctx } as unknown as Parameters<typeof handleOAuthUserInfo>[0];
    const second = await handleOAuthUserInfo(c, {
      userInfo: { ...profile("mover-two"), email: first.user.email, id: "1002" },
      account: { ...githubAccount("1002"), scope: "" },
    });

    expect(second.data).toBeNull();
    expect(second.error).toBe("account not linked");
    expect(await ia.findAccountByKey({ providerId: "github", accountId: "1002" })).toBeNull();
    expect(await ctx.adapter.count({ model: "user" })).toBe(1);
    expect((await ia.findAccounts(first.user.id)).map((a) => a.accountId)).toEqual(["1001"]);
  });

  it("undoes only rows that still hold what the failed transaction wrote", async () => {
    const { prefix, ctx } = await build();
    const row = (id: string, token: string) => ({
      id,
      token,
      userId: "u-live",
      expiresAt: new Date(Date.now() + 600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      ctx.adapter.transaction(async (trx) => {
        await trx.create({ model: "session", data: row("s-own", "own"), forceAllowId: true });
        await trx.create({ model: "session", data: row("s-taken", "first"), forceAllowId: true });
        // Another writer replaces s-taken under the same id before the failure.
        await ctx.adapter.delete({ model: "session", where: [{ field: "id", value: "s-taken" }] });
        await ctx.adapter.create({ model: "session", data: row("s-taken", "second"), forceAllowId: true });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const left = await ctx.adapter.findMany<{ id: string; token: string }>({ model: "session" });
    expect(left.map((r) => [r.id, r.token])).toEqual([["s-taken", "second"]]);
    expect(await redis(["SMEMBERS", keys.indexKey(prefix, "session", "token", "own")])).toEqual([]);
    expect(await redis(["SMEMBERS", keys.indexKey(prefix, "session", "token", "second")])).toEqual(["s-taken"]);
  });

  it("keeps an identical row that was already there when a transaction's create is refused", async () => {
    const { prefix, ctx } = await build();
    const at = new Date();
    const row = { id: "s-dup", token: "dup", userId: "u-live", expiresAt: new Date(at.getTime() + 600_000), createdAt: at, updatedAt: at };
    await ctx.adapter.create({ model: "session", data: { ...row }, forceAllowId: true });
    await expect(
      ctx.adapter.transaction(async (trx) => {
        await trx.create({ model: "session", data: { ...row }, forceAllowId: true });
      }),
    ).rejects.toThrow(/row s-dup already exists/);
    expect((await ctx.adapter.findMany<{ id: string }>({ model: "session" })).map((r) => r.id)).toEqual(["s-dup"]);
    expect(await redis(["SMEMBERS", keys.indexKey(prefix, "session", "token", "dup")])).toEqual(["s-dup"]);
  });

  it("undoes a row the failed transaction created and then updated", async () => {
    const { prefix, ctx } = await build();
    const email = profile("updater").email;
    await expect(
      ctx.adapter.transaction(async (trx) => {
        const u = await trx.create<{ id: string }>({ model: "user", data: { name: "Up", email, emailVerified: true } });
        await trx.update({ model: "user", where: [{ field: "id", value: u.id }], update: { name: "Updated" } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await ctx.adapter.count({ model: "user" })).toBe(0);
    expect(await redis(["SMEMBERS", keys.indexKey(prefix, "user", "email", email)])).toEqual([]);
  });

  it("keeps an identical row that was already there when a refused create's reply is lost", async () => {
    const { prefix, ctx } = await build();
    const at = new Date();
    const row = { id: "s-lost", token: "lost", userId: "u-live", expiresAt: new Date(at.getTime() + 600_000), createdAt: at, updatedAt: at };
    await ctx.adapter.create({ model: "session", data: { ...row }, forceAllowId: true });
    relay.hook = async (cmds, real) => {
      const replies = await real(cmds);
      const c = cmds[0];
      if (c[0] === "EVAL" && c[5] === "session" && c[6] === "s-lost" && c[7] === "") {
        relay.hook = null;
        throw new Error("fetch failed");
      }
      return replies;
    };
    try {
      await expect(
        ctx.adapter.transaction(async (trx) => {
          await trx.create({ model: "session", data: { ...row }, forceAllowId: true });
        }),
      ).rejects.toThrow(/create session failed: fetch failed/);
    } finally {
      relay.hook = null;
    }
    expect((await ctx.adapter.findMany<{ id: string }>({ model: "session" })).map((r) => r.id)).toEqual(["s-lost"]);
    expect(await redis(["SMEMBERS", keys.indexKey(prefix, "session", "token", "lost")])).toEqual(["s-lost"]);
  });

  it("leaves no orphan user when the account write fails, so the next sign-in succeeds", async () => {
    const { prefix, ctx } = await build();
    const ia = ctx.internalAdapter;
    // An account already holding github:2001 makes the new sign-in's account
    // write fail on its unique key, after its user row is written.
    const blocker = await ia.createOAuthUser(profile("holder"), githubAccount("2001"));
    const email = profile("newcomer").email;

    await expect(ia.createOAuthUser(profile("newcomer"), githubAccount("2001"))).rejects.toThrow(
      /unique providerId\+accountId taken/,
    );
    expect(await ia.findUserByEmail(email)).toBeNull();
    expect(await ctx.adapter.count({ model: "user" })).toBe(1);
    expect(await redis(["SMEMBERS", keys.indexKey(prefix, "user", "email", email)])).toEqual([]);

    await ctx.adapter.delete({ model: "account", where: [{ field: "id", value: blocker.account!.id }] });
    const c = { context: ctx } as unknown as Parameters<typeof handleOAuthUserInfo>[0];
    const retry = await handleOAuthUserInfo(c, {
      userInfo: { ...profile("newcomer"), id: "2001" },
      account: { ...githubAccount("2001"), scope: "" },
    });
    expect(retry.error).toBeNull();
    expect(retry.data?.user.email).toBe(email);
    expect((await ia.findAccountByKey({ providerId: "github", accountId: "2001" }))?.userId).toBe(retry.data?.user.id);
  });

  describe("linking GitHub to a signed-in player", () => {
    // linkOnUserWrite writes the real ctf:link:* keys, outside the liveKey
    // namespace, so every login carries this run's id (no two runs on one Redis
    // share one) and every key is removed afterwards.
    const written: string[][] = [];
    const freshLogin = () => `octo-${RUN}-${freshId("l")}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
    async function kitUser(ia: Awaited<ReturnType<typeof build>>["ctx"]["internalAdapter"], tag: string) {
      const email = `${tag}-${freshId("u")}@demo.invalid`.toLowerCase();
      const user = await ia.createUser({ name: `Kit ${tag}`, email, emailVerified: true, image: "https://kit.example.test/me.png" }, { method: "admin" });
      return { ...user, email };
    }
    async function linkKeys(userId: string, login: string) {
      written.push(["DEL", linkKey(login), `${LINK_USER_PREFIX}${userId}`], ["HDEL", LINK_AT_KEY, userId]);
      return {
        owner: await redis(["GET", linkKey(login)]),
        at: await redis(["HGET", LINK_AT_KEY, userId]),
      };
    }
    afterAll(async () => {
      for (const cmd of written) await redis(cmd);
    });

    it("links an account whose email differs, records the link, and keeps the kit name and avatar", async () => {
      const { ctx, link } = await build();
      const ia = ctx.internalAdapter;
      const u1 = await kitUser(ia, "u1");
      const login = freshLogin();

      const res = await link({ userId: u1.id, kitEmail: u1.email, accountId: "gh-1", login, ghEmail: "octo@github.example.test" });

      expect(res).toEqual({ linked: true });
      expect((await ia.findAccountByKey({ providerId: "github", accountId: "gh-1" }))?.userId).toBe(u1.id);
      const k = await linkKeys(u1.id, login);
      expect(k.owner).toBe(u1.id);
      expect(Number(k.at)).toBeGreaterThan(0);
      const after = (await ia.findUserById(u1.id)) as (User & { name: string; image: string }) | null;
      expect(after).toMatchObject({ name: "Kit u1", image: "https://kit.example.test/me.png", email: u1.email, login });
    });

    it("refuses a GitHub account another player has linked and moves no link key", async () => {
      const { ctx, link } = await build();
      const ia = ctx.internalAdapter;
      const u1 = await kitUser(ia, "first");
      const u2 = await kitUser(ia, "second");
      const login = freshLogin();
      expect((await link({ userId: u1.id, kitEmail: u1.email, accountId: "gh-2", login, ghEmail: "a@github.example.test" })).linked).toBe(true);
      const before = await linkKeys(u1.id, login);

      const res = await link({ userId: u2.id, kitEmail: u2.email, accountId: "gh-2", login, ghEmail: "a@github.example.test" });

      expect(res).toEqual({ linked: false, error: { code: "account_already_linked_to_different_user" } });
      expect(await linkKeys(u1.id, login)).toEqual(before);
      expect(await linkKeys(u2.id, login)).toEqual({ owner: u1.id, at: null });
      expect(await redis(["GET", `${LINK_USER_PREFIX}${u2.id}`])).toBeNull();
      expect((await ia.findAccountByKey({ providerId: "github", accountId: "gh-2" }))?.userId).toBe(u1.id);
    });

    it("refuses /link-social for a player who already has a link, and no link key moves", async () => {
      const { instance, ctx, link } = await build();
      const ia = ctx.internalAdapter;
      const u1 = await kitUser(ia, "linked");
      const login = freshLogin();
      expect((await link({ userId: u1.id, kitEmail: u1.email, accountId: "gh-4", login, ghEmail: "l@github.example.test" })).linked).toBe(true);
      const before = await linkKeys(u1.id, login);
      const headers = await sessionHeaders(ctx, u1.id);

      const err = await instance.api
        .linkSocialAccount({ body: { provider: "github", callbackURL: "/profile?linked=github" }, headers })
        .then(() => null, (e: unknown) => e as { status?: string; body?: { code?: string } });

      expect(err?.status).toBe("FORBIDDEN");
      expect(err?.body?.code).toBe("GITHUB_ALREADY_LINKED");
      // Refused before any OAuth state is written, so no callback can follow.
      expect(await ctx.adapter.count({ model: "verification" })).toBe(0);
      expect(await linkKeys(u1.id, login)).toEqual(before);
      expect(await redis(["GET", `${LINK_USER_PREFIX}${u1.id}`])).toBe(login);
      expect((await ia.findAccounts(u1.id)).map((a) => a.accountId)).toEqual(["gh-4"]);
    });

    it("lets an unlinked player start /link-social", async () => {
      // The control for the refusal above: the same call, no link, goes to GitHub.
      const { instance, ctx } = await build();
      const u1 = await kitUser(ctx.internalAdapter, "fresh");
      const headers = await sessionHeaders(ctx, u1.id);
      const res = await instance.api.linkSocialAccount({ body: { provider: "github", callbackURL: "/profile?linked=github" }, headers });
      expect(res.url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    });

    it("re-runs the link write when the same player links the same GitHub account again", async () => {
      // A first link whose login key another player held: better-auth keeps
      // the account row, the link write is refused. Once the key is free, the
      // same link again re-runs the user update and records it.
      const { ctx, link } = await build();
      const ia = ctx.internalAdapter;
      const u1 = await kitUser(ia, "retry");
      const login = freshLogin();
      const squatter = "00000000-0000-4000-8000-000000000000";
      written.push(["DEL", linkKey(login)]);
      await redis(["SET", linkKey(login), squatter]);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const input = { userId: u1.id, kitEmail: u1.email, accountId: "gh-3", login, ghEmail: "r@github.example.test" };

      expect(await link(input)).toEqual({ linked: true });
      expect(await linkKeys(u1.id, login)).toEqual({ owner: squatter, at: null });
      expect(errors.mock.calls.map((c) => String(c[0]))).toEqual(["[auth] github login already linked to another player"]);
      errors.mockRestore();

      await redis(["DEL", linkKey(login)]);
      expect(await link(input)).toEqual({ linked: true });
      expect((await linkKeys(u1.id, login)).owner).toBe(u1.id);
      expect((await ia.findAccounts(u1.id)).map((a) => a.accountId)).toEqual(["gh-3"]);
    });
  });
});
