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

vi.hoisted(() => {
  // betterAuth() runs at import time and warns on a weak secret. Only fills
  // gaps, so a real .env.local still wins locally.
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.GITHUB_CLIENT_ID ??= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";
});

import { auth, authOptions, refuseSecondGithubLink } from "@/lib/auth";
import { APIError } from "better-auth/api";

/**
 * The only endpoints this app actually exercises over HTTP.
 *
 *   /sign-in/social  authClient.signIn.social({ provider: "github" })
 *   /link-social     authClient.linkSocial({ provider: "github" }), the
 *                    signed-in player's Link GitHub button
 *   /callback/:id    GitHub's OAuth redirect back, for sign-in and for a link
 *   /get-session     authClient.useSession()
 *   /sign-out        authClient.signOut()
 *   /ok, /error      better-auth's own health and error surfaces
 *
 * Server-side auth.api.getSession() is a direct function call and never
 * touches the router, so it does not belong here.
 */
const IN_USE = ["/sign-in/social", "/link-social", "/callback/:id", "/get-session", "/sign-out", "/ok", "/error"];

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
  it("classifies every mounted endpoint as in use, disabled, or documented-inert", () => {
    const mounted = Object.values(auth.api)
      .map((endpoint) => (endpoint as { path?: string }).path)
      .filter((path): path is string => typeof path === "string");

    // Sanity: if this ever reads zero, the assertion below is vacuous.
    expect(mounted.length).toBeGreaterThan(20);

    const unclassified = mounted.filter(
      (p) => !IN_USE.includes(p) && !NOT_CLOSEABLE.includes(p) && !disabledPaths.includes(p),
    );
    expect(unclassified).toEqual([]);
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
    // The hook body is a thin wrapper around recordCallbackLogin, whose path
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
