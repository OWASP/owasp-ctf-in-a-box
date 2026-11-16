// Pins the better-auth HTTP surface.
//
// better-auth mounts its ENTIRE default endpoint set behind the catch-all at
// app/api/auth/[...all], whether or not this app uses any of it. The one that
// mattered was POST /update-user: an arbitrary JSON body behind nothing but
// sessionMiddleware, run through parseUserInput (which accepts `login`,
// because that field must stay `input: true` for OAuth profile mapping to
// work) and written to the user row. Any signed-in contestant could have
// become any other contestant and spent their points.
//
// The test that matters is the first one: it fails when a better-auth upgrade
// introduces a default endpoint nobody has classified. That is the failure
// mode a hand-written list of "paths we remembered to close" cannot catch.

import { describe, expect, it, vi } from "vitest";

// auth.ts now imports activity-log.ts (the sign-in hook, issue #212), which
// carries `server-only` and the Upstash client — inert here (the hook never
// fires at import time) but the marker import itself throws outside a Server
// Component, so it is stubbed like every other suite does.
vi.mock("server-only", () => ({}));

const linkOnUserWrite = vi.hoisted(() => vi.fn<(user: unknown) => Promise<void>>(async () => {}));
const getGithubLink = vi.hoisted(() => vi.fn<(id: string) => Promise<{ login: string; linkedAt: number | null } | null>>());
vi.mock("@/lib/github-link", () => ({ linkOnUserWrite, getGithubLink }));

const getSessionFromCtx = vi.hoisted(() => vi.fn<(ctx: unknown) => Promise<unknown>>());
vi.mock("better-auth/api", async (orig) => ({
  ...(await orig<typeof import("better-auth/api")>()),
  getSessionFromCtx,
}));

// No Redis here: a sign-up that reached the store would call one of these,
// so a refused request is proven refused by neither being called.
const redisCalls = vi.hoisted(() => ({
  pipeline: vi.fn(async () => {
    throw new Error("no Redis in the unit suite");
  }),
  eval: vi.fn(async () => {
    throw new Error("no Redis in the unit suite");
  }),
}));
vi.mock("@/lib/upstash", async (orig) => ({
  ...(await orig<typeof import("@/lib/upstash")>()),
  upstashPipeline: redisCalls.pipeline,
  upstashEval: redisCalls.eval,
}));

const consumeRateLimit = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>>(async () => ({ allowed: true })),
);
vi.mock("@/lib/rate-limit-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit-store")>()),
  consumeRateLimit,
}));

vi.hoisted(() => {
  // betterAuth() runs at import time and warns on a weak secret. Only fills
  // gaps, so a real .env.local still wins locally.
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.GITHUB_CLIENT_ID ??= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";
});

import { auth, authOptions, refuseClientOAuthParams, refuseSecondGithubLink, refuseSignUpFields } from "@/lib/auth";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { APIError } from "better-auth/api";

/**
 * The endpoints this app exercises over HTTP: every path a client can reach.
 *
 *   /sign-up/email     username + password sign-up (refuseSignUpFields closes
 *                      it to every identity field but the username)
 *   /sign-in/username  username + password sign-in
 *   /sign-in/social    authClient.signIn.social({ provider: "github" })
 *   /link-social       authClient.linkSocial({ provider: "github" }), the
 *                      signed-in player's Link GitHub button
 *   /callback/:id      GitHub's OAuth redirect back, for sign-in and for a link
 *   /get-session       authClient.useSession()
 *   /sign-out          authClient.signOut()
 *
 * Server-side auth.api.getSession() is a direct function call and never
 * touches the router, so it does not belong here.
 */
const IN_USE = ["/sign-up/email", "/sign-in/username", "/sign-in/social", "/link-social", "/callback/:id", "/get-session", "/sign-out"];

/** better-auth's own health and error surfaces: reachable, and they read no input. */
const BUILTIN = ["/ok", "/error"];

/**
 * Mounted, unused, and NOT closeable by disabledPaths.
 *
 * disabledPaths compares against normalizePathname(), which returns the
 * literal request path — there is no route-pattern matching. A real request
 * arrives as /reset-password/abc123, which never equals "/reset-password/:token",
 * so listing the pattern would read as protection while doing nothing.
 *
 * It is inert for a different reason: reset-password is gated on config this
 * app does not set. Verified against a running build — POST
 * /api/auth/request-password-reset answers 400 RESET_PASSWORD_DISABLED. The
 * token-consuming half is unreachable without the half that issues tokens.
 */
const NOT_CLOSEABLE = ["/reset-password/:token"];

const disabledPaths = auth.options.disabledPaths ?? [];

describe("better-auth exposed surface", () => {
  it("leaves open exactly the paths the app uses, besides the built-in and documented-inert ones", () => {
    const mounted = Object.values(auth.api)
      .map((endpoint) => (endpoint as { path?: string }).path)
      .filter((path): path is string => typeof path === "string");

    // Sanity: if this ever reads zero, the assertion below is vacuous.
    expect(mounted.length).toBeGreaterThan(20);

    const open = mounted.filter((p) => !BUILTIN.includes(p) && !NOT_CLOSEABLE.includes(p) && !disabledPaths.includes(p));
    expect([...open].sort()).toEqual([...IN_USE].sort());
  });

  it("contains no parameterized path, which disabledPaths cannot match", () => {
    // A ":" here means someone believed a route was closed when every real
    // request to it sails straight through.
    expect(disabledPaths.filter((p) => p.includes(":"))).toEqual([]);
  });

  it("closes /update-user, the path that made `login` client-writable", () => {
    expect(disabledPaths).toContain("/update-user");
  });

  it("keeps unlinking and the linked-account disclosures closed", () => {
    // One GitHub account links to one kit account and a player cannot undo
    // it; nothing lists or describes linked accounts to the client.
    for (const path of ["/unlink-account", "/list-accounts", "/account-info", "/update-user"]) {
      expect(disabledPaths).toContain(path);
    }
  });

  it("closes the provider-token endpoints", () => {
    expect(disabledPaths).toContain("/get-access-token");
    expect(disabledPaths).toContain("/refresh-token");
  });

  it("never disables an endpoint the app depends on", () => {
    for (const path of IN_USE) expect(disabledPaths).not.toContain(path);
  });
});

describe("Redis-backed sign-in state (#736)", () => {
  it("stores users and sessions in the Redis adapter", () => {
    expect(authOptions.database).toBeDefined();
  });

  it("re-checks the stored session at least every 5 minutes", () => {
    expect(authOptions.session.cookieCache.maxAge).toBeLessThanOrEqual(300);
  });

  it("never reissues the cookie cache without reading the session row", () => {
    // refreshCache would let a revoked session live on; version "1" would
    // trust the 7-day stateless caches minted under it.
    const cache: { refreshCache?: unknown; version?: string } = authOptions.session.cookieCache;
    expect(cache.refreshCache).toBeFalsy();
    expect(cache.version).not.toBe("1");
  });

  it("never links a GitHub identity to an existing user by email", () => {
    expect(authOptions.account.accountLinking.disableImplicitLinking).toBe(true);
    expect(authOptions.account.storeAccountCookie).toBe(false);
  });

  it("lets a signed-in player link a GitHub account whose email differs from theirs", () => {
    expect(authOptions.account.accountLinking.allowDifferentEmails).toBe(true);
    expect(authOptions.account.accountLinking.updateUserInfoOnLink).toBe(true);
  });

  it("requests no OAuth scopes beyond the provider defaults", () => {
    expect((authOptions.socialProviders.github as { scope?: unknown }).scope).toBeUndefined();
  });

  it("refreshes the GitHub login on every sign-in", () => {
    expect(authOptions.socialProviders.github.overrideUserInfoOnSignIn).toBe(true);
  });
});

describe("user.additionalFields.login", () => {
  it("stays input-accepting, because `input: false` breaks OAuth sign-in", () => {
    // better-auth's parseAdditionalUserInputFromProviderProfile skips fields
    // marked `input: false` when mapping the GitHub profile, which leaves
    // session.user.login undefined and breaks the /profile gate. The safety
    // here comes from /update-user being closed, NOT from this flag — so this
    // test exists to stop a well-meaning "fix" that would regress sign-in.
    // The literal type infers `input` away entirely (it is left at its
    // default), so read it back as the wider shape better-auth acts on.
    const login = auth.options.user?.additionalFields?.login as { input?: boolean } | undefined;
    expect(login).toBeDefined();
    expect(login?.input).not.toBe(false);
  });
});

describe("sign-in activity hook (issue #212)", () => {
  it("registers an after hook, the login capture point", () => {
    // The hook body is a thin wrapper around recordSignIn, whose path
    // filter and login extraction are pinned in activity-log.test.ts. This
    // pins only that the wiring exists — remove the hook and sign-ins
    // silently stop being recorded.
    expect(typeof auth.options.hooks?.after).toBe("function");
  });
});

describe("player ids", () => {
  it("generates lowercase v4 uuids", async () => {
    const { PLAYER_ID_RE } = await import("@/lib/player");
    const gen = authOptions.advanced.database.generateId;
    expect(gen()).toMatch(PLAYER_ID_RE);
  });
});

describe("github link hooks", () => {
  // better-auth writes the user row on create (a new player) and on update
  // (a returning one, overrideUserInfoOnSignIn), so both must record the link
  // or a renamed GitHub account keeps resolving to nobody.
  it.each(["create", "update"] as const)("user.%s.after hands the written row to linkOnUserWrite", async (op) => {
    linkOnUserWrite.mockClear();
    const row = { id: "5f0c2a1e-7b3d-4c9e-8a21-0d6f4b9e3c71", login: "octocat", name: "Mona" };
    const after = authOptions.databaseHooks.user[op].after as unknown as (user: typeof row, ctx: unknown) => Promise<void>;
    await after(row, null);
    expect(linkOnUserWrite).toHaveBeenCalledExactlyOnceWith(row);
  });
});

describe("user.update.before", () => {
  // better-auth merges the hook's `data` over what it was handed
  // (db/with-hooks.mjs), and its adapter skips an `undefined` field on update,
  // so the row write is this merge minus the undefined keys.
  type Before = (data: Record<string, unknown>, ctx: { path?: string } | null) => Promise<{ data: Record<string, unknown> } | void>;
  const before = authOptions.databaseHooks.user.update.before as unknown as Before;
  const written = async (data: Record<string, unknown>, ctx: { path?: string } | null) => {
    const result = await before(data, ctx);
    const merged = { ...data, ...(result ? result.data : {}) };
    return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  };
  const profile = { login: "octocat", name: "Octo", image: "u" };

  it("keeps the login but not the GitHub name or avatar on the OAuth callback", async () => {
    expect(await written(profile, { path: "/callback/:id" })).toEqual({ login: "octocat" });
  });

  it.each([undefined, "/update-user", "/sign-in/social", "/callback/github"])("leaves an update on path %s alone", async (path) => {
    expect(await written(profile, path === undefined ? null : { path })).toEqual(profile);
  });
});

describe("refuseSecondGithubLink (/link-social before hook)", () => {
  // One GitHub account per kit account, and no unlink: a player who already
  // has a link cannot start a second one, which would move their link and
  // release the old login.
  const ID = "5f0c2a1e-7b3d-4c9e-8a21-0d6f4b9e3c71";
  const ctx = (path: string) => ({ path }) as unknown as Parameters<typeof refuseSecondGithubLink>[0];
  const status = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    return (err as APIError).status;
  };

  it("is wired as the before hook", () => {
    expect(typeof auth.options.hooks?.before).toBe("function");
  });

  it("refuses a player who already has a GitHub link", async () => {
    getSessionFromCtx.mockResolvedValue({ user: { id: ID } });
    getGithubLink.mockResolvedValue({ login: "octocat", linkedAt: 1 });
    expect(await status(refuseSecondGithubLink(ctx("/link-social")))).toBe("FORBIDDEN");
    expect(getGithubLink).toHaveBeenCalledWith(ID);
  });

  it("lets an unlinked player start the link", async () => {
    getSessionFromCtx.mockResolvedValue({ user: { id: ID } });
    getGithubLink.mockResolvedValue(null);
    await expect(refuseSecondGithubLink(ctx("/link-social"))).resolves.toBeUndefined();
  });

  it("fails closed when the link cannot be read, logging only the label", async () => {
    getSessionFromCtx.mockResolvedValue({ user: { id: ID } });
    getGithubLink.mockRejectedValue(new Error("github link: GET failed: NOAUTH"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await status(refuseSecondGithubLink(ctx("/link-social")))).toBe("SERVICE_UNAVAILABLE");
    const logged = errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    errors.mockRestore();
    expect(logged).toContain("NOAUTH");
    expect(logged).not.toContain(ID);
  });

  it("leaves a request with no session to the endpoint's own 401", async () => {
    getSessionFromCtx.mockResolvedValue(null);
    getGithubLink.mockClear();
    await expect(refuseSecondGithubLink(ctx("/link-social"))).resolves.toBeUndefined();
    expect(getGithubLink).not.toHaveBeenCalled();
  });

  it.each(["/sign-in/social", "/callback/:id", "/get-session"])("ignores %s", async (path) => {
    getSessionFromCtx.mockClear();
    getGithubLink.mockClear();
    await expect(refuseSecondGithubLink(ctx(path))).resolves.toBeUndefined();
    expect(getSessionFromCtx).not.toHaveBeenCalled();
    expect(getGithubLink).not.toHaveBeenCalled();
  });
});

describe("refuseClientOAuthParams (OAuth for identity only)", () => {
  // better-auth forwards a client-supplied `scopes` and `additionalParams`
  // into the provider authorization URL. The kit uses the provider for
  // identity alone, so a request carrying either key is refused, not trimmed.
  const ctx = (path: string, body: unknown) => ({ path, body }) as unknown as Parameters<typeof refuseClientOAuthParams>[0];
  const refused = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    return err as APIError;
  };

  it.each(["/sign-in/social", "/link-social"])("refuses scopes and additionalParams on %s, whatever the value", async (path) => {
    const values: unknown[] = [["repo"], [], { prompt: "consent" }, {}, "repo", null, undefined];
    for (const key of ["scopes", "additionalParams"]) {
      for (const value of values) {
        const err = await refused(refuseClientOAuthParams(ctx(path, { provider: "github", [key]: value })));
        expect(err.status).toBe("BAD_REQUEST");
        expect(err.body?.code).toBe("OAUTH_PARAMS_NOT_ALLOWED");
      }
    }
  });

  it("is wired into the before hook ahead of the link check", async () => {
    getSessionFromCtx.mockClear();
    const hook = auth.options.hooks?.before as unknown as (c: unknown) => Promise<unknown>;
    const err = await refused(hook({ path: "/link-social", body: { provider: "github", scopes: ["repo"] } }));
    expect(err.status).toBe("BAD_REQUEST");
    expect(getSessionFromCtx).not.toHaveBeenCalled();
  });

  it.each(["/sign-in/social", "/link-social"])("lets a plain %s request through", async (path) => {
    await expect(refuseClientOAuthParams(ctx(path, { provider: "github", callbackURL: "/profile" }))).resolves.toBeUndefined();
  });

  it("leaves other paths and a missing body alone", async () => {
    await expect(refuseClientOAuthParams(ctx("/get-session", { scopes: ["repo"] }))).resolves.toBeUndefined();
    await expect(refuseClientOAuthParams(ctx("/sign-in/social", undefined))).resolves.toBeUndefined();
  });
});

const BASE = "http://localhost:3000/api/auth";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  auth.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": "10.0.0.1", ...headers },
      body: JSON.stringify(body),
    }),
  );
const VALID = { username: "Alice", password: "x".repeat(12) };

describe("username and password configuration", () => {
  it("enables email/password with the kit's password bounds and no reset mail", () => {
    const ep = authOptions.emailAndPassword as Record<string, unknown>;
    expect(ep).toMatchObject({ enabled: true, minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: true, requireEmailVerification: false });
    expect(ep.sendResetPassword).toBeUndefined();
  });

  it("turns better-auth's own limiter off, leaving limitAuthAttempt's budgets", () => {
    expect(authOptions.rateLimit.enabled).toBe(false);
  });

  it.each(["/sign-in/social", "/link-social"])("charges the kit limiter on %s through the before hook", async (path) => {
    consumeRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 9 });
    const res = await post(path, { provider: "github", callbackURL: "/profile" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9");
  });

  it("runs the username plugin, with nextCookies last", () => {
    expect(authOptions.plugins.map((p) => p.id)).toEqual(["username", "next-cookies"]);
  });
});

describe("refuseSignUpFields (/sign-up/email before hook)", () => {
  const ctx = (path: string, body: unknown) => ({ path, body }) as unknown as Parameters<typeof refuseSignUpFields>[0];
  const refused = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    return err as APIError;
  };

  it("fills a placeholder email and the typed username as the name", async () => {
    const c = ctx("/sign-up/email", { username: " Alice ", password: "x".repeat(12) });
    await refuseSignUpFields(c);
    const body = c.body as Record<string, string>;
    expect(isPlaceholderEmail(body.email)).toBe(true);
    expect(body.username).toBe("Alice");
    expect(body.displayUsername).toBe("Alice");
    expect(body.name).toBe("Alice");
  });

  it("takes a displayUsername that is the same username in another case", async () => {
    const c = ctx("/sign-up/email", { username: "alice", displayUsername: "ALICE", password: "x".repeat(12) });
    await refuseSignUpFields(c);
    expect((c.body as Record<string, string>).name).toBe("ALICE");
  });

  it("refuses a displayUsername that only lowercases to the username", async () => {
    // U+212A KELVIN SIGN lowercases to "k".
    const err = await refused(refuseSignUpFields(ctx("/sign-up/email", { username: "kate", displayUsername: "\u212Aate", password: "x".repeat(12) })));
    expect(err.body?.code).toBe("SIGN_UP_FIELD_REFUSED");
  });

  it("refuses a displayUsername that names someone else", async () => {
    const err = await refused(refuseSignUpFields(ctx("/sign-up/email", { username: "alice", displayUsername: "dcotelo", password: "x".repeat(12) })));
    expect(err.body?.code).toBe("SIGN_UP_FIELD_REFUSED");
  });

  it.each([undefined, null, "alice", ["alice"], { password: "x".repeat(12) }, { username: 7, password: "x".repeat(12) }])(
    "refuses body %j",
    async (body) => {
      const err = await refused(refuseSignUpFields(ctx("/sign-up/email", body)));
      expect(err.status).toBe("BAD_REQUEST");
    },
  );

  it("leaves other paths alone", async () => {
    const body = { login: "someone" };
    await expect(refuseSignUpFields(ctx("/sign-in/username", body))).resolves.toBeUndefined();
    expect(body).toEqual({ login: "someone" });
  });
});

describe("sign-up over HTTP", () => {
  it.each(["login", "email", "name", "image", "emailVerified", "id", "foo", "username ", "__proto__", "createdAt", "role"])(
    "refuses a body carrying %j before anything reaches Redis",
    async (field) => {
      redisCalls.pipeline.mockClear();
      redisCalls.eval.mockClear();
      const res = await auth.handler(
        new Request(`${BASE}/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": "10.0.0.1" },
          // Raw JSON so "__proto__" arrives as an own key, as an attacker's would.
          body: `{"username":"alice","password":"${"x".repeat(12)}",${JSON.stringify(field)}:"x"}`,
        }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("SIGN_UP_FIELD_REFUSED");
      expect(redisCalls.pipeline).not.toHaveBeenCalled();
    },
  );

  it("refuses an identity field sent as a form body too", async () => {
    redisCalls.pipeline.mockClear();
    const res = await auth.handler(
      new Request(`${BASE}/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:3000", "x-forwarded-for": "10.0.0.1" },
        body: new URLSearchParams({ username: "alice", password: "x".repeat(12), login: "someone" }).toString(),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("SIGN_UP_FIELD_REFUSED");
    expect(redisCalls.pipeline).not.toHaveBeenCalled();
  });

  it("charges the rate limit before it reads the body", async () => {
    consumeRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 42 });
    const res = await post("/sign-up/email", { ...VALID, login: "someone" });
    expect(res.status).toBe(429);
  });

  it.each(["/sign-up/email", "/sign-in/username"])("answers a refused %s with 429, Retry-After and the seconds in the body", async (path) => {
    consumeRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 42 });
    const res = await post(path, VALID);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 42 });
  });

  it.each(["/sign-in/email", "/is-username-available", "/update-user", "/change-password", "/set-password"])("answers %s with 404", async (path) => {
    const res = await post(path, { ...VALID, email: "a@b.test", newPassword: "y".repeat(12), currentPassword: "x".repeat(12) });
    expect(res.status).toBe(404);
  });
});
