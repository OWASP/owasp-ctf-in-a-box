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
import { handleOAuthUserInfo, linkOAuthAccount, parseState } from "better-auth/oauth2";
import { authOptions } from "@/lib/auth";
import * as keys from "@/lib/auth-store/keys";
import { LINK_AT_KEY, LINK_PENDING_PREFIX, LINK_USER_PREFIX, linkKey } from "@/lib/github-link";
import { redisAdapter } from "@/lib/auth-store/redis-adapter";
import { withWriteFenceSlot } from "@/lib/auth-store/write-fence";
import { upstashPipeline as pipeline } from "@/lib/upstash";
import { ADMIN_SETTINGS_KEY } from "@/lib/admin-store";
import { ACTIVITY_LOG_KEY } from "@/lib/activity-keys";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
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
  process.env.GITHUB_CLIENT_ID ||= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ||= "test-client-secret";
});

type User = { id: string; email: string; login?: string };

type LinkInput = { userId: string; kitEmail: string; accountId: string; login: string; ghEmail: string };
type ProbeBody = Omit<LinkInput, "userId" | "kitEmail">;
type LinkResult = { linked: boolean; error?: { code: string } };

// The link half of GitHub's callback, mounted at the callback's own route and
// called with `id: github`, so the hooks see the endpoint context a real link
// runs under. It parses the state a real /link-social minted, as the callback
// does: parseState is what puts `link` in the request's OAuth state, which
// gateOAuthCallback reads to tell a link from a sign-in. Test-only: the token
// exchange between the two needs GitHub.
const linkProbe = {
  id: "link-probe",
  endpoints: {
    linkProbe: createAuthEndpoint("/callback/:id", { method: "POST" }, async (c) => {
      const b = c.body as ProbeBody;
      const { link } = await parseState(c);
      if (!link) throw new Error("link probe: the state carries no link");
      return c.json(
        await linkOAuthAccount(c, {
          link,
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
  const ctx = await instance.$context;
  // The probe declares no body schema, so its typed input is `undefined`.
  const probe = instance.api.linkProbe as unknown as (input: {
    body: ProbeBody;
    query: { state: string };
    params: { id: string };
    headers: Headers;
  }) => Promise<LinkResult>;
  // Starts the link as the player's browser would and returns the completion:
  // GitHub's callback with the state and state cookie /link-social handed out.
  const startLink = async (userId: string) => {
    const session = await sessionHeaders(ctx, userId);
    const started = await instance.api.linkSocialAccount({
      body: { provider: "github", callbackURL: "/profile?linked=github" },
      headers: session,
      returnHeaders: true,
    });
    const state = new URL(started.response.url).searchParams.get("state");
    if (!state) throw new Error("link probe: /link-social returned no state");
    const stateCookies = started.headers.getSetCookie().map((c) => c.split(";")[0]);
    const cookie = [session.get("cookie"), ...stateCookies].join("; ");
    // Inside a write fence slot, as the auth route runs every request.
    return ({ accountId, login, ghEmail }: ProbeBody) =>
      withWriteFenceSlot(() =>
        probe({ body: { accountId, login, ghEmail }, query: { state }, params: { id: "github" }, headers: new Headers({ cookie }) }),
      );
  };
  const link = async ({ userId, ...body }: LinkInput) => (await startLink(userId))(body);
  return { prefix, instance, ctx, link, startLink };
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
      written.push(["DEL", linkKey(login), `${LINK_USER_PREFIX}${userId}`, `${LINK_PENDING_PREFIX}${userId}`], ["HDEL", LINK_AT_KEY, userId]);
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

    it("keeps the first link when two link flows started while unlinked both complete, and no link key moves", async () => {
      // Both starts pass refuseSecondGithubLink, since neither link is recorded
      // yet; the second completion has to be refused at the callback.
      const { ctx, startLink } = await build();
      const ia = ctx.internalAdapter;
      const u1 = await kitUser(ia, "twotabs");
      const first = freshLogin();
      const second = freshLogin();
      const completeFirst = await startLink(u1.id);
      const completeSecond = await startLink(u1.id);

      expect(await completeFirst({ accountId: "gh-5", login: first, ghEmail: "t1@github.example.test" })).toEqual({ linked: true });
      const before = await linkKeys(u1.id, first);
      expect(before.owner).toBe(u1.id);
      // Released once the row was written, so nothing is left to hold up an
      // organizer's unlink and a relink.
      expect(await redis(["EXISTS", `${LINK_PENDING_PREFIX}${u1.id}`])).toBe(0);

      const err = await completeSecond({ accountId: "gh-6", login: second, ghEmail: "t2@github.example.test" }).then(
        () => null,
        (e: unknown) => e as { status?: string; body?: { code?: string } },
      );

      expect(err?.status).toBe("FORBIDDEN");
      expect(err?.body?.code).toBe("GITHUB_ALREADY_LINKED");
      expect(await linkKeys(u1.id, first)).toEqual(before);
      expect(await redis(["GET", `${LINK_USER_PREFIX}${u1.id}`])).toBe(first);
      expect((await linkKeys(u1.id, second)).owner).toBeNull();
      expect((await ia.findAccounts(u1.id)).map((a) => a.accountId)).toEqual(["gh-5"]);
      expect(await ia.findAccountByKey({ providerId: "github", accountId: "gh-6" })).toBeNull();
    });

    it("lets exactly one of two overlapping link completions through, and leaves no second GitHub account", async () => {
      // Both completions can read "no link" before either records one; the
      // link claim decides which may write its account row. A second row left
      // on the player would let a later GitHub sign-in through it move the
      // link as if it were a rename.
      const { ctx, startLink } = await build();
      const ia = ctx.internalAdapter;
      const u1 = await kitUser(ia, "overlap");
      const logins = { "gh-7": freshLogin(), "gh-8": freshLogin() };
      const completions = await Promise.all([startLink(u1.id), startLink(u1.id)]);
      // Each completion's read of the player's account rows is held until the
      // other one reaches its own read, or 300 ms pass, so the reads overlap
      // whatever the scheduling. Without the claim both would reach it and
      // find no GitHub row; with it the second is refused before reading.
      const rowsRead = `:account:by:userId:${u1.id}`;
      let reads = 0;
      let bothRead!: () => void;
      const overlap = new Promise<void>((resolve) => (bothRead = resolve));
      relay.hook = async (cmds, real) => {
        if (cmds.some((c) => c[0] === "SMEMBERS" && String(c[1]).endsWith(rowsRead))) {
          if (++reads === 2) bothRead();
          await Promise.race([overlap, new Promise((resolve) => setTimeout(resolve, 300))]);
        }
        return real(cmds);
      };

      const results = await Promise.allSettled([
        completions[0]({ accountId: "gh-7", login: logins["gh-7"], ghEmail: "o1@github.example.test" }),
        completions[1]({ accountId: "gh-8", login: logins["gh-8"], ghEmail: "o2@github.example.test" }),
      ]).finally(() => {
        relay.hook = null;
      });

      expect(reads).toBe(1);
      const linked = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      expect(linked.map((r) => r.value)).toEqual([{ linked: true }]);
      expect(refused.map((r) => (r.reason as { body?: { code?: string } }).body?.code)).toEqual(["GITHUB_ALREADY_LINKED"]);
      const accounts = (await ia.findAccounts(u1.id)).map((a) => a.accountId);
      expect(accounts).toHaveLength(1);
      const winner = accounts[0] as keyof typeof logins;
      const loser = winner === "gh-7" ? "gh-8" : "gh-7";
      expect(await redis(["GET", `${LINK_USER_PREFIX}${u1.id}`])).toBe(logins[winner]);
      expect((await linkKeys(u1.id, logins[winner])).owner).toBe(u1.id);
      expect((await linkKeys(u1.id, logins[loser])).owner).toBeNull();
      expect(await ia.findAccountByKey({ providerId: "github", accountId: loser })).toBeNull();
    });

    it("refuses the account write of a link callback whose claim lapsed after its checks, and writes no row", async () => {
      // A callback that stalls past the claim's expiry after passing its
      // checks must not write: another callback may have claimed and linked
      // meanwhile. The claim is dropped (as its expiry would) once this
      // callback has read the player's account rows, so its next step is the
      // fenced account write.
      const { ctx, startLink } = await build();
      const ia = ctx.internalAdapter;
      const u1 = await kitUser(ia, "lapsed");
      const login = freshLogin();
      const complete = await startLink(u1.id);
      const rowsRead = `:account:by:userId:${u1.id}`;
      let dropped = false;
      relay.hook = async (cmds, real) => {
        const reply = await real(cmds);
        if (!dropped && cmds.some((c) => c[0] === "SMEMBERS" && String(c[1]).endsWith(rowsRead))) {
          dropped = true;
          await real([["DEL", `${LINK_PENDING_PREFIX}${u1.id}`]]);
        }
        return reply;
      };
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const outcome = await complete({ accountId: "gh-11", login, ghEmail: "l@github.example.test" }).then(
        () => "linked",
        () => "refused",
      ).finally(() => {
        relay.hook = null;
        errors.mockRestore();
      });

      expect(dropped).toBe(true);
      expect(outcome).toBe("refused");
      expect(await ia.findAccountByKey({ providerId: "github", accountId: "gh-11" })).toBeNull();
      expect((await ia.findAccounts(u1.id)).filter((a) => a.providerId === "github")).toEqual([]);
      expect(await redis(["GET", `${LINK_USER_PREFIX}${u1.id}`])).toBeNull();
      expect((await linkKeys(u1.id, login)).owner).toBeNull();
    });

    it("refuses a second GitHub account for a player whose first link the kit refused, and lets the first retry", async () => {
      // A refused link (another player held the login) keeps its account row
      // with no link. A second account on top of it would let a later sign-in
      // through the first move the link as if it were a rename.
      const { ctx, link } = await build();
      const ia = ctx.internalAdapter;
      const u1 = await kitUser(ia, "refused");
      const login = freshLogin();
      const other = freshLogin();
      const squatter = "00000000-0000-4000-8000-000000000001";
      written.push(["DEL", linkKey(login)]);
      await redis(["SET", linkKey(login), squatter]);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const firstTry = { userId: u1.id, kitEmail: u1.email, accountId: "gh-9", login, ghEmail: "f@github.example.test" };
      expect(await link(firstTry)).toEqual({ linked: true });
      errors.mockRestore();
      expect(await redis(["GET", `${LINK_USER_PREFIX}${u1.id}`])).toBeNull();

      const err = await link({ userId: u1.id, kitEmail: u1.email, accountId: "gh-10", login: other, ghEmail: "o@github.example.test" }).then(
        () => null,
        (e: unknown) => e as { status?: string; body?: { code?: string } },
      );

      expect(err?.body?.code).toBe("GITHUB_ALREADY_LINKED");
      expect((await ia.findAccounts(u1.id)).map((a) => a.accountId)).toEqual(["gh-9"]);
      expect((await linkKeys(u1.id, other)).owner).toBeNull();
      expect(await redis(["EXISTS", `${LINK_PENDING_PREFIX}${u1.id}`])).toBe(0);
      await redis(["DEL", linkKey(login)]);
      expect(await link(firstTry)).toEqual({ linked: true });
      expect((await linkKeys(u1.id, login)).owner).toBe(u1.id);
    });

    it("lets an unlinked player start /link-social", async () => {
      // The control for the refusal above: the same call, no link, goes to GitHub.
      const { instance, ctx } = await build();
      const u1 = await kitUser(ctx.internalAdapter, "fresh");
      const headers = await sessionHeaders(ctx, u1.id);
      const res = await instance.api.linkSocialAccount({ body: { provider: "github", callbackURL: "/profile?linked=github" }, headers });
      expect(res.url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    });

    it("builds the authorization URL with the kit's scope, and refuses client scopes and params on both paths", async () => {
      const { instance, ctx } = await build();
      const u1 = await kitUser(ctx.internalAdapter, "scoped");
      const headers = await sessionHeaders(ctx, u1.id);
      const base = { provider: "github", callbackURL: "/profile" };
      const scopeOf = (url: string) => new URL(url).searchParams.get("scope");

      const plainSignIn = await instance.api.signInSocial({ body: base });
      const plainLink = await instance.api.linkSocialAccount({ body: base, headers });
      const kitScope = scopeOf(plainSignIn.url ?? "");
      expect(kitScope).toBeTruthy();
      expect(scopeOf(plainLink.url)).toBe(kitScope);
      expect(kitScope).not.toContain("repo");

      const verificationsBefore = await ctx.adapter.count({ model: "verification" });
      const extras: Array<{ scopes?: string[]; additionalParams?: Record<string, string> }> = [
        { scopes: ["repo"] },
        { scopes: [] },
        { additionalParams: { prompt: "consent" } },
        { additionalParams: {} },
      ];
      for (const extra of extras) {
        const signIn = await instance.api
          .signInSocial({ body: { ...base, ...extra } })
          .then(() => null, (e: unknown) => e as { status?: string; body?: { code?: string } });
        expect(signIn?.status).toBe("BAD_REQUEST");
        expect(signIn?.body?.code).toBe("OAUTH_PARAMS_NOT_ALLOWED");
        const link = await instance.api
          .linkSocialAccount({ body: { ...base, ...extra }, headers })
          .then(() => null, (e: unknown) => e as { status?: string; body?: { code?: string } });
        expect(link?.status).toBe("BAD_REQUEST");
        expect(link?.body?.code).toBe("OAUTH_PARAMS_NOT_ALLOWED");
      }
      expect(await ctx.adapter.count({ model: "verification" })).toBe(verificationsBefore);
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

  describe("username and password sign-up and sign-in over HTTP", () => {
    // The app's own plugins (username, nextCookies) and hooks, over a
    // suite-scoped prefix. Each test signs up from its own address, so the
    // real per-address budgets of limitAuthAttempt never carry over.
    async function buildPasswordAuth(overrides: Partial<typeof authOptions> = {}) {
      const prefix = liveKey("auth-password", freshId("p"));
      const instance = betterAuth({ ...authOptions, database: redisAdapter({ prefix }), ...overrides });
      const ctx = await instance.$context;
      const ip = `live-${RUN}-${freshId("ip")}`;
      const post = async (path: string, body: unknown) => {
        const res = await instance.handler(
          new Request(`http://localhost:3000/api/auth${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": ip },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
        );
        const text = await res.text();
        return { res, body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null };
      };
      return { prefix, ctx, post, instance };
    }
    const pw = (n: number) => "p".repeat(n);
    type Row = { id: string; email: string; name: string; username?: string; displayUsername?: string; login?: string };

    it("sign-up creates an account with a placeholder email and the username as name", async () => {
      const { ctx, post } = await buildPasswordAuth();
      const { res, body } = await post("/sign-up/email", { username: "Alice", password: pw(12) });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain(ctx.authCookies.sessionToken.name);
      const rows = await ctx.adapter.findMany<Row>({ model: "user" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ username: "alice", displayUsername: "Alice", name: "Alice" });
      expect(rows[0].login).toBeUndefined();
      expect(isPlaceholderEmail(rows[0].email)).toBe(true);
      expect((body?.user as Row).id).toBe(rows[0].id);
      const accounts = await ctx.internalAdapter.findAccounts(rows[0].id);
      expect(accounts.map((a) => a.providerId)).toEqual(["credential"]);
    });

    it.each(["login", "email", "name", "image", "emailVerified", "id", "foo"])("refuses a sign-up body carrying %s and writes no user", async (field) => {
      const { ctx, post } = await buildPasswordAuth();
      const value = field === "emailVerified" ? true : field === "email" ? "a@b.test" : "someone";
      const { res, body } = await post("/sign-up/email", { username: "alice", password: pw(12), [field]: value });
      expect(res.status).toBe(400);
      expect(body?.code).toBe("SIGN_UP_FIELD_REFUSED");
      expect(await ctx.adapter.count({ model: "user" })).toBe(0);
    });

    it("refuses passwords of 11 and 129 characters and takes 12 and 128", async () => {
      const { ctx, post } = await buildPasswordAuth();
      expect((await post("/sign-up/email", { username: "short", password: pw(11) })).res.status).toBe(400);
      expect((await post("/sign-up/email", { username: "long", password: pw(129) })).res.status).toBe(400);
      expect(await ctx.adapter.count({ model: "user" })).toBe(0);
      expect((await post("/sign-up/email", { username: "twelve", password: pw(12) })).res.status).toBe(200);
      expect((await post("/sign-up/email", { username: "maxlen", password: pw(128) })).res.status).toBe(200);
      expect(await ctx.adapter.count({ model: "user" })).toBe(2);
    });

    it("refuses a username taken in another case", async () => {
      const { ctx, post } = await buildPasswordAuth();
      expect((await post("/sign-up/email", { username: "alice", password: pw(12) })).res.status).toBe(200);
      const second = await post("/sign-up/email", { username: "ALICE", password: pw(12) });
      expect(second.res.status).toBe(400);
      expect(second.body?.code).toBe("USERNAME_IS_ALREADY_TAKEN");
      expect(await ctx.adapter.count({ model: "user" })).toBe(1);
    });

    it("signs in by username in any case, and answers a wrong password with the generic 401", async () => {
      const { post } = await buildPasswordAuth();
      expect((await post("/sign-up/email", { username: "alice", password: pw(12) })).res.status).toBe(200);
      const ok = await post("/sign-in/username", { username: "ALICE", password: pw(12) });
      expect(ok.res.status).toBe(200);
      expect(ok.res.headers.get("set-cookie")).toBeTruthy();
      const wrong = await post("/sign-in/username", { username: "alice", password: pw(13) });
      expect(wrong.res.status).toBe(401);
      expect(wrong.body?.message).toBe("Invalid username or password");
      const nobody = await post("/sign-in/username", { username: "nobody", password: pw(12) });
      expect(nobody.res.status).toBe(401);
      expect(nobody.body?.message).toBe("Invalid username or password");
    });

    it("logs a sign-up and a password sign-in to the activity log, and not a refused sign-in", async () => {
      const { ctx, post } = await buildPasswordAuth();
      const name = `Logged${freshId("u").replace(/[^a-z0-9]/g, "")}`;
      const entriesFor = async (id: string) =>
        ((await redis(["LRANGE", ACTIVITY_LOG_KEY, 0, -1])) as string[])
          .map((row) => JSON.parse(row) as { type: string; userId?: string; name?: string })
          .filter((e) => e.userId === id);
      expect((await post("/sign-up/email", { username: name, password: pw(12) })).res.status).toBe(200);
      const [user] = await ctx.adapter.findMany<Row>({ model: "user" });
      expect(await entriesFor(user.id)).toEqual([expect.objectContaining({ type: "login", name })]);
      expect((await post("/sign-in/username", { username: name, password: pw(13) })).res.status).toBe(401);
      expect(await entriesFor(user.id)).toHaveLength(1);
      expect((await post("/sign-in/username", { username: name, password: pw(12) })).res.status).toBe(200);
      expect(await entriesFor(user.id)).toHaveLength(2);
    });

    it("adds a password to a GitHub account, then signs in by username with it, once", async () => {
      const { ctx, post, instance } = await buildPasswordAuth();
      const { user } = await ctx.internalAdapter.createOAuthUser(
        { name: "ada", email: "ada@example.test", emailVerified: true, image: null, login: "ada" } as never,
        { providerId: "github", accountId: `acct-${freshId("a")}` } as never,
      );
      await ctx.internalAdapter.updateUser(user.id, { username: "ada_gh", displayUsername: "ada_gh" });
      const headers = await sessionHeaders(ctx as never, user.id);
      const call = (newPassword: string) => instance.api.setPassword({ headers, body: { newPassword } });
      const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as { body?: { code?: string } } | null)?.body?.code;

      expect(await code(call(pw(11)))).toBe("PASSWORD_TOO_SHORT");
      expect(await code(call(pw(129)))).toBe("PASSWORD_TOO_LONG");
      expect((await ctx.internalAdapter.findAccounts(user.id)).map((a) => a.providerId)).toEqual(["github"]);

      await expect(call(pw(12))).resolves.toBeTruthy();
      expect((await ctx.internalAdapter.findAccounts(user.id)).map((a) => a.providerId).sort()).toEqual(["credential", "github"]);
      expect((await post("/sign-in/username", { username: "ada_gh", password: pw(12) })).res.status).toBe(200);

      expect(await code(call("q".repeat(20)))).toBe("PASSWORD_ALREADY_SET");
      expect((await post("/sign-in/username", { username: "ada_gh", password: pw(12) })).res.status).toBe(200);
      expect((await post("/sign-in/username", { username: "ada_gh", password: "q".repeat(20) })).res.status).toBe(401);
      // Server-only: no HTTP route reaches it.
      expect((await post("/set-password", { newPassword: pw(12) })).res.status).toBe(404);
    });

    it("signs up and in while team registration is closed", async () => {
      // Account creation is not team registration: closing the registration
      // window must not lock players out of the box.
      // It writes the shared ctf:admin:settings hash, which is safe only
      // because the upstash suites run serially (--no-file-parallelism, AGENTS.md).
      const fields = ["teamRegistrationOpen", "registrationStartsAt", "registrationEndsAt"];
      const saved = (await redis(["HMGET", ADMIN_SETTINGS_KEY, ...fields])) as (string | null)[];
      const past = new Date(Date.now() - 3_600_000).toISOString();
      await redis(["HSET", ADMIN_SETTINGS_KEY, "teamRegistrationOpen", "0", "registrationStartsAt", past, "registrationEndsAt", past]);
      try {
        const { post } = await buildPasswordAuth();
        expect((await post("/sign-up/email", { username: "latecomer", password: pw(12) })).res.status).toBe(200);
        expect((await post("/sign-in/username", { username: "latecomer", password: pw(12) })).res.status).toBe(200);
      } finally {
        for (const [i, f] of fields.entries()) {
          await redis(saved[i] === null ? ["HDEL", ADMIN_SETTINGS_KEY, f] : ["HSET", ADMIN_SETTINGS_KEY, f, saved[i] as string]);
        }
      }
    });

    it("does not refuse 5 sign-ins inside 10 s from one address with better-auth's own limiter", async () => {
      // better-auth turns its limiter on by default in production, where it
      // allows 3 sign-ins per 10 s. NODE_ENV is "test" here, so an unset
      // `enabled` is stood in for by the production default.
      const { post } = await buildPasswordAuth({ rateLimit: { ...authOptions.rateLimit, enabled: authOptions.rateLimit?.enabled ?? true } });
      expect((await post("/sign-up/email", { username: "burst", password: pw(12) })).res.status).toBe(200);
      for (let i = 0; i < 5; i++) {
        expect((await post("/sign-in/username", { username: "burst", password: pw(12) })).res.status).toBe(200);
      }
    });
  });
});
