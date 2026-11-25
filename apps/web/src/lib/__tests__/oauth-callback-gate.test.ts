// Drives the OAuth callback over HTTP with the app's auth config, an in-memory
// database and GitHub's token and profile endpoints stubbed, to pin that the
// admin switch gates the COMPLETION of a GitHub sign-in and not only its
// start: the OAuth state names no provider, so a state minted while the
// switch was on can still reach the callback after an organizer turns it off.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getGithubLink = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/github-link", () => ({ linkOnUserWrite: vi.fn(async () => {}), getGithubLink }));

const getAdminSettings = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock("@/lib/admin-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin-store")>()),
  getAdminSettings,
}));

vi.mock("@/lib/upstash", async (orig) => ({
  ...(await orig<typeof import("@/lib/upstash")>()),
  upstashPipeline: vi.fn(async () => {
    throw new Error("no Redis in the unit suite");
  }),
  upstashEval: vi.fn(async () => {
    throw new Error("no Redis in the unit suite");
  }),
}));

vi.mock("@/lib/rate-limit-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit-store")>()),
  consumeRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.GITHUB_CLIENT_ID = "gh-id";
  process.env.GITHUB_CLIENT_SECRET = "gh-secret";
});

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { authOptions } from "@/lib/auth";

type Row = Record<string, unknown>;
type Db = { user: Row[]; account: Row[]; session: Row[]; verification: Row[] };

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/auth`;

function build() {
  const db: Db = { user: [], account: [], session: [], verification: [] };
  const instance = betterAuth({ ...authOptions, database: memoryAdapter(db) });
  return { db, instance };
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

function githubSwitch(on: boolean) {
  getAdminSettings.mockResolvedValue({ signInProviders: { github: on } });
}

// The provider side of the code exchange and the profile read.
function stubProviders() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return json({ access_token: "provider-token", token_type: "Bearer", scope: "read:user user:email" });
    }
    if (url.startsWith("https://api.github.com/user/emails")) {
      return json([{ email: "octo@github.test", primary: true, verified: true }]);
    }
    if (url.startsWith("https://api.github.com/user")) {
      return json({ id: 583231, login: "octocat", name: "Octo", email: "octo@github.test", avatar_url: "https://avatars.test/o.png" });
    }
    return real(input, init);
  });
}

type Instance = ReturnType<typeof build>["instance"];

async function post(instance: Instance, path: string, body: unknown, cookie = "") {
  return instance.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "10.0.0.1", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

/** Starts a flow and returns its state and the cookies the browser now holds. */
async function start(instance: Instance, path: "/sign-in/social" | "/link-social", provider: string, cookie = "") {
  const res = await post(instance, path, { provider, callbackURL: "/done" }, cookie);
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  return { state: state!, cookie: [cookie, cookiesOf(res)].filter(Boolean).join("; ") };
}

async function callback(instance: Instance, provider: string, flow: { state: string; cookie: string }) {
  return instance.handler(
    new Request(`${BASE}/callback/${provider}?code=auth-code&state=${encodeURIComponent(flow.state)}`, {
      method: "GET",
      headers: { cookie: flow.cookie, "x-forwarded-for": "10.0.0.1" },
    }),
  );
}

const errorOf = (res: Response) => new URL(res.headers.get("location") ?? "", ORIGIN).searchParams.get("error");
const setsSession = (res: Response) => res.headers.getSetCookie().some((c) => c.includes("session_token=") && !/session_token=;/.test(c));

async function signedInPlayer(instance: Instance) {
  const res = await post(instance, "/sign-up/email", { username: "Alice", password: "x".repeat(12) });
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

describe("OAuth callback completion is gated on the GitHub sign-in switch", () => {
  let fetchSpy: ReturnType<typeof stubProviders>;
  beforeEach(() => {
    fetchSpy = stubProviders();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    getAdminSettings.mockReset();
  });

  it("completes a GitHub sign-in with the switch on (the control)", async () => {
    const { db, instance } = build();
    githubSwitch(true);
    const res = await callback(instance, "github", await start(instance, "/sign-in/social", "github"));
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBeNull();
    expect(setsSession(res)).toBe(true);
    expect(db.account.map((a) => a.providerId)).toEqual(["github"]);
    expect(db.session).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("refuses a sign-in state minted while GitHub was on, completed after it is switched off", async () => {
    const { db, instance } = build();
    githubSwitch(true);
    const flow = await start(instance, "/sign-in/social", "github");
    githubSwitch(false);
    const res = await callback(instance, "github", flow);
    expect(errorOf(res)).toBe("PROVIDER_DISABLED");
    expect(setsSession(res)).toBe(false);
    expect(db.user).toEqual([]);
    expect(db.account).toEqual([]);
    expect(db.session).toEqual([]);
  });

  it("refuses a returning player's sign-in once GitHub is switched off", async () => {
    const { db, instance } = build();
    githubSwitch(true);
    await callback(instance, "github", await start(instance, "/sign-in/social", "github"));
    expect(db.session).toHaveLength(1);
    const flow = await start(instance, "/sign-in/social", "github");
    githubSwitch(false);
    const res = await callback(instance, "github", flow);
    expect(errorOf(res)).toBe("PROVIDER_DISABLED");
    expect(setsSession(res)).toBe(false);
    expect(db.session).toHaveLength(1);
  });

  // better-auth itself refuses a link whose user row is gone; this pins that,
  // so a link started before an organizer's delete cannot complete after it.
  it("writes no GitHub account when the player was deleted between starting the link and its callback (#822)", async () => {
    const { db, instance } = build();
    githubSwitch(true);
    const player = await signedInPlayer(instance);
    const flow = await start(instance, "/link-social", "github", player);
    db.user.splice(0, db.user.length); // the organizer deletes the account now
    const res = await callback(instance, "github", flow);
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBe("unable_to_link_account");
    expect(db.account.filter((a) => a.providerId === "github")).toEqual([]);
  });

  it("still completes a GitHub link with GitHub sign-in switched off", async () => {
    const { db, instance } = build();
    githubSwitch(false);
    const player = await signedInPlayer(instance);
    const sessions = db.session.length;
    const res = await callback(instance, "github", await start(instance, "/link-social", "github", player));
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBeNull();
    expect(db.account.filter((a) => a.providerId === "github")).toHaveLength(1);
    expect(db.session).toHaveLength(sessions);
  });

  // Only GitHub is mounted, so a callback naming any other provider has no
  // handler behind it, whatever the state.
  it.each(["google", "discord"])("a callback at /callback/%s writes nothing", async (provider) => {
    const { db, instance } = build();
    githubSwitch(true);
    const player = await signedInPlayer(instance);
    const users = db.user.length;
    const sessions = db.session.length;
    for (const flow of [
      await start(instance, "/sign-in/social", "github"),
      await start(instance, "/link-social", "github", player),
    ]) {
      const res = await callback(instance, provider, flow);
      expect(errorOf(res)).toBe("oauth_provider_not_found");
      expect(setsSession(res)).toBe(false);
    }
    expect(db.user).toHaveLength(users);
    expect(db.account.filter((a) => a.providerId !== "credential")).toEqual([]);
    expect(db.session).toHaveLength(sessions);
  });

  it("fails closed when the switch cannot be read on the callback", async () => {
    const { db, instance } = build();
    githubSwitch(true);
    const flow = await start(instance, "/sign-in/social", "github");
    getAdminSettings.mockRejectedValue(new Error("HGETALL failed: NOAUTH"));
    const res = await callback(instance, "github", flow);
    expect(errorOf(res)).toBe("SIGN_IN_SETTINGS_UNREADABLE");
    expect(setsSession(res)).toBe(false);
    expect(db.user).toEqual([]);
    expect(db.session).toEqual([]);
  });
});
