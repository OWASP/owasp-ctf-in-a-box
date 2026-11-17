// The 5-minute session cookie cache must not keep serving a username-less
// user after the pick: the route's response cookies have to carry the updated
// user. Real better-auth (in-memory store) and the real store; only the
// per-login budget is faked.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.hoisted(() => {
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.GITHUB_CLIENT_ID ||= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ||= "test-client-secret";
});
vi.mock("@/lib/github-link", () => ({ linkOnUserWrite: async () => {}, getGithubLink: async () => null }));
vi.mock("@/lib/rate-limit-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit-store")>()),
  consumeRateLimit: async () => ({ allowed: true }),
}));

// next/headers has no request scope here; nextCookies() reads it best-effort.
vi.mock("next/headers", () => ({
  cookies: async () => {
    throw new Error("outside a request scope");
  },
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  const { betterAuth } = await import("better-auth");
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  const db = { user: [], session: [], account: [], verification: [] };
  return { ...real, auth: betterAuth({ ...real.authOptions, database: memoryAdapter(db) }) };
});

import { auth } from "@/lib/auth";
import { POST } from "@/app/api/me/username/route";

async function signedInAs(login: string) {
  const ctx = await auth.$context;
  const { user } = await ctx.internalAdapter.createOAuthUser(
    { name: login, email: `${login}@example.test`, emailVerified: true, image: null, login } as never,
    { providerId: "github", accountId: login } as never,
  );
  // The id must pass PLAYER_ID_RE: better-auth's generateId in authOptions mints v4 UUIDs.
  const { token } = await ctx.internalAdapter.createSession(user.id);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(ctx.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, enc.encode(token))).toString("base64");
  const cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${sig}`)}`;
  return { id: user.id, cookie };
}

/** What a browser sends next: the jar, with each Set-Cookie replacing the
 *  cookie of the same name. */
function applySetCookies(jar: Map<string, string>, res: { headers: Headers }): void {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

describe("POST /api/me/username refreshes the session cookie", () => {
  it("a getSession on the browser's jar after the response sees the username, past a stale cookie cache", async () => {
    const { cookie } = await signedInAs("octo");
    const jar = new Map<string, string>();
    const eq = cookie.indexOf("=");
    jar.set(cookie.slice(0, eq), cookie.slice(eq + 1));

    // A page load mints the cookie cache with the username-less user.
    const primed = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(jar) }), returnHeaders: true });
    applySetCookies(jar, primed);
    const cacheName = (await auth.$context).authCookies.sessionData.name;
    expect([...jar.keys()].some((k) => k.startsWith(cacheName))).toBe(true);
    // With that cache, the old user is still served: the failure the refresh prevents.
    const stale = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(jar) }) });
    expect(stale?.user.username ?? null).toBeNull();

    const res = await POST(
      new Request("http://box.test/api/me/username", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeader(jar) },
        body: JSON.stringify({ username: "Bob" }),
      }),
    );
    expect(res.status).toBe(200);
    applySetCookies(jar, res);

    const after = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(jar) }) });
    expect((after?.user as { username?: string }).username).toBe("bob");
    expect((after?.user as { displayUsername?: string }).displayUsername).toBe("Bob");
  });

  it("already_set re-signs a second browser's stale cache, so it stops bouncing to /welcome", async () => {
    const { cookie } = await signedInAs("twobrowsers");
    const browser = async () => {
      const jar = new Map<string, string>();
      const eq = cookie.indexOf("=");
      jar.set(cookie.slice(0, eq), cookie.slice(eq + 1));
      applySetCookies(jar, await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(jar) }), returnHeaders: true }));
      return jar;
    };
    const first = await browser();
    const second = await browser();
    const post = (jar: Map<string, string>, username: string) =>
      POST(
        new Request("http://box.test/api/me/username", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: cookieHeader(jar) },
          body: JSON.stringify({ username }),
        }),
      );

    expect((await post(first, "Alice")).status).toBe(200);
    // The second browser's cache was minted before the pick.
    const stale = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(second) }) });
    expect(stale?.user.username ?? null).toBeNull();

    const res = await post(second, "Other");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_set" });
    applySetCookies(second, res);
    const after = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(second) }) });
    expect((after?.user as { username?: string }).username).toBe("alice");
  });

  it("expires the stale cache but keeps the session token when the refresh fails", async () => {
    const { cookie } = await signedInAs("refreshfails");
    const jar = new Map<string, string>();
    const eq = cookie.indexOf("=");
    jar.set(cookie.slice(0, eq), cookie.slice(eq + 1));
    applySetCookies(jar, await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(jar) }), returnHeaders: true }));
    const ctx = await auth.$context;
    const cacheName = ctx.authCookies.sessionData.name;
    const tokenName = ctx.authCookies.sessionToken.name;
    expect([...jar.keys()].some((k) => k.startsWith(cacheName))).toBe(true);
    const tokenBefore = jar.get(tokenName);

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // Only the route's refresh (the read past the cache) fails; getPlayer's
    // own read still sees the session.
    const real = auth.api.getSession.bind(auth.api);
    vi.spyOn(auth.api, "getSession").mockImplementation(((args: { query?: { disableCookieCache?: boolean } }) =>
      args.query?.disableCookieCache ? Promise.reject(new Error("store blip")) : real(args as never)) as never);
    const res = await POST(
      new Request("http://box.test/api/me/username", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeader(jar) },
        body: JSON.stringify({ username: "Dana" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    const set = res.headers.getSetCookie();
    expect(set.some((c) => c.startsWith(`${cacheName}=;`) && /Max-Age=0/.test(c))).toBe(true);
    expect(set.some((c) => c.startsWith(`${tokenName}=`))).toBe(false);

    // The browser drops the expired cache and keeps its token; the next read
    // comes from the store and sees the pick.
    for (const c of set) if (/Max-Age=0/.test(c)) jar.delete(c.split("=")[0]);
    vi.mocked(auth.api.getSession).mockRestore();
    expect(jar.get(tokenName)).toBe(tokenBefore);
    expect([...jar.keys()].some((k) => k.startsWith(cacheName))).toBe(false);
    const after = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(jar) }) });
    expect((after?.user as { username?: string }).username).toBe("dana");
  });
});

afterEach(() => vi.restoreAllMocks());
