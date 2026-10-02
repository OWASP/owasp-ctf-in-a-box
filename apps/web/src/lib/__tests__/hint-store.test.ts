// Unit tests for the hint store — most importantly that a hint purchase
// charges exactly once (the SADD guard precedes the HINCRBY inside the Lua
// script) and that everything is keyed by the server-derived login. Upstash
// is mocked; end-to-end Lua behavior is covered by hint-store.upstash.test.ts.

import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(script: string, keys: string[], args: (string | number)[]) => Promise<unknown>>(),
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
  getAdminSettings: vi.fn(),
  isModuleLive: vi.fn<(id: string) => Promise<boolean>>(),
}));

vi.mock("server-only", () => ({}));
// #463: no stories on this board unless a test says otherwise.
const storyMocks = vi.hoisted(() => ({ listStories: vi.fn(async () => [] as unknown[]), teamSolveKeys: vi.fn(async () => [] as string[]) }));
vi.mock("@/lib/classic-store", () => ({
  listStories: storyMocks.listStories,
  listChallengeIds: async () => new Set(["recon", "web", "web-robots-only"]),
}));
vi.mock("@/lib/classic-team", () => ({ teamSolveKeys: storyMocks.teamSolveKeys }));
vi.mock("@/lib/upstash", () => ({
  upstashEval: mocks.upstashEval,
  upstashPipeline: mocks.upstashPipeline,
}));
vi.mock("@/lib/admin-store", () => ({
  getAdminSettings: mocks.getAdminSettings,
}));
vi.mock("@/lib/enabled-modules", () => ({
  isModuleLive: mocks.isModuleLive,
}));

type HintStore = typeof import("@/lib/hint-store");

/** No admin override set — `hintsEnabled: null` is the "organizer has never
 *  touched the toggle" state, which resolves to HINT_DEFAULT_ENABLED. */
const BASE_SETTINGS = {
  paused: false,
  hintsEnabled: null,
  hintCost: null,
  // Gate off by default here so the purchase-path tests below stay focused
  // on charging; the gate has its own describe block.
  hintsMinSolves: 0,
  hintsUnlockAfterMin: 0,
  scoringStartsAt: null,
  updatedBy: null,
  updatedAt: null,
};

/** `HINTS_AVAILABLE` (Upstash credentials present) is read at module load, so
 *  each test re-imports the store with the env it needs.
 *
 *  `enabled` is NOT an env var any more — hints are switched from /admin, so
 *  it maps to the stored `hintsEnabled` override and these tests exercise the
 *  same path an organizer does. Absent means ON (HINT_DEFAULT_ENABLED). */
async function loadStore(enabled = true, { creds = true }: { creds?: boolean } = {}): Promise<HintStore> {
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", creds ? "https://fake.upstash.io" : "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", creds ? "fake-token" : "");
  if (!enabled) {
    mocks.getAdminSettings.mockResolvedValue({ ...BASE_SETTINGS, hintsEnabled: false });
  }
  return import("@/lib/hint-store");
}

beforeEach(() => {
  vi.clearAllMocks();
  // Hints belong to the Secure Development module; every test below assumes
  // it is enabled unless it says otherwise.
  mocks.isModuleLive.mockResolvedValue(true);
  // Default: no admin override present, so every test not exercising the
  // override sees only the baked env default (as before this override existed).
  mocks.getAdminSettings.mockResolvedValue({ ...BASE_SETTINGS });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("revealHint", () => {
  it("charges a new hint and returns the text", async () => {
    const store = await loadStore();
    mocks.upstashEval.mockResolvedValueOnce(["charged", "Check the admin route.", 10]);
    const result = await store.revealHint("octocat", "juice-shop", "Challenge-5-Admin-Section");
    expect(result).toEqual({ ok: true, hint: "Check the admin route.", alreadyOwned: false, spent: 10, cost: 10 });
  });

  // The classic target (#190): same charge machinery, its own hint hash and
  // its own module gate. These pin the KEYS the script gets, because the key
  // is the isolation — a classic purchase must never read a scorer hash.
  it("reveals a classic hint from ctf:classic:hints, charged into the shared spend", async () => {
    const store = await loadStore();
    mocks.upstashEval.mockResolvedValueOnce(["charged", "Look at robots.txt.", 10]);
    const result = await store.revealHint("octocat", "classic", "web-robots-only");
    expect(result).toEqual({ ok: true, hint: "Look at robots.txt.", alreadyOwned: false, spent: 10, cost: 10 });
    const [, keys, argv] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual([
      "ctf:user:octocat:hints",
      "ctf:hints:spent",
      "ctf:classic:hints",
      "ctf:hints:at:octocat",
    ]);
    expect(argv[1]).toBe("classic/web-robots-only");
  });

  it("gates classic hints on the CLASSIC module, not secure-development", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockImplementation(async (id: string) => id === "classic");
    mocks.upstashEval.mockResolvedValueOnce(["charged", "text", 10]);
    // classic on, secure-development off: classic reveals work…
    await expect(store.revealHint("octocat", "classic", "web-robots-only")).resolves.toMatchObject({ ok: true });
    // …and a secure-development reveal is refused.
    await expect(store.revealHint("octocat", "juice-shop", "Challenge-1")).resolves.toMatchObject({ ok: false });
  });

  // The ai target (issue #211): same charge machinery, its own hint hash and
  // its own module gate — pinning the KEYS the script gets the same way the
  // classic test above does, so an ai purchase can never read a scorer hash.
  it("reveals an ai hint from ctf:ai:hints, charged into the shared spend", async () => {
    const store = await loadStore();
    mocks.upstashEval.mockResolvedValueOnce(["charged", "Ignore prior instructions.", 10]);
    const result = await store.revealHint("octocat", "ai", "prompt-injection-1");
    expect(result).toEqual({ ok: true, hint: "Ignore prior instructions.", alreadyOwned: false, spent: 10, cost: 10 });
    const [, keys, argv] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual(["ctf:user:octocat:hints", "ctf:hints:spent", "ctf:ai:hints", "ctf:hints:at:octocat"]);
    expect(argv[1]).toBe("ai/prompt-injection-1");
  });

  it("gates ai hints on the AI module, not secure-development", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockImplementation(async (id: string) => id === "ai");
    mocks.upstashEval.mockResolvedValueOnce(["charged", "text", 10]);
    // ai on, secure-development off: ai reveals work…
    await expect(store.revealHint("octocat", "ai", "prompt-injection-1")).resolves.toMatchObject({ ok: true });
    // …and a secure-development reveal is refused.
    await expect(store.revealHint("octocat", "juice-shop", "Challenge-1")).resolves.toMatchObject({ ok: false });
  });

  it("returns an owned hint for free", async () => {
    const store = await loadStore();
    mocks.upstashEval.mockResolvedValueOnce(["owned", "Check the admin route.", "10"]);
    const result = await store.revealHint("octocat", "juice-shop", "Challenge-5-Admin-Section");
    expect(result).toEqual({ ok: true, hint: "Check the admin route.", alreadyOwned: true, spent: 10, cost: 10 });
  });

  it("checks the hint exists and guards with SADD BEFORE charging (atomic)", async () => {
    const store = await loadStore();
    mocks.upstashEval.mockResolvedValueOnce(["charged", "text", 10]);
    await store.revealHint("octocat", "juice-shop", "Challenge-5-Admin-Section");
    const [script] = mocks.upstashEval.mock.calls[0];
    const hget = script.indexOf("HGET");
    const sadd = script.indexOf("SADD");
    const charge = script.indexOf("HINCRBY");
    expect(hget).toBeGreaterThan(-1);
    expect(hget).toBeLessThan(sadd);
    expect(sadd).toBeLessThan(charge);
  });

  it("keys the purchase by the server-derived login and app/id pair", async () => {
    const store = await loadStore();
    mocks.upstashEval.mockResolvedValueOnce(["charged", "text", 10]);
    await store.revealHint("octocat", "juice-shop", "Challenge-5-Admin-Section");
    const [, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual([
      "ctf:user:octocat:hints",
      "ctf:hints:spent",
      "hints:juice-shop",
      // When it was bought (issue #169). A separate key, not a conversion of
      // the SET above — that would be a WRONGTYPE on every live event.
      "ctf:hints:at:octocat",
    ]);
    expect(args.slice(0, 4)).toEqual([
      "Challenge-5-Admin-Section",
      "juice-shop/Challenge-5-Admin-Section",
      "octocat",
      10,
    ]);
    // The purchase time is the server's, never the caller's.
    expect(String(args[4])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stamps the purchase time with HSETNX, so a re-reveal cannot move it", async () => {
    // Re-revealing an owned hint takes the 'owned' branch and charges nothing;
    // HSETNX means it also cannot rewrite when the hint was first bought,
    // which is what the before/after-solve split depends on.
    const store = await loadStore();
    mocks.upstashEval.mockResolvedValueOnce(["owned", "text", 10]);
    await store.revealHint("octocat", "juice-shop", "Challenge-5-Admin-Section");
    const [script] = mocks.upstashEval.mock.calls[0];
    expect(script).toContain("HSETNX");
    // ...and the stamp lives on the charge path only.
    const charged = script.slice(script.indexOf("SADD"), script.indexOf("return {'charged'"));
    expect(charged).toContain("HSETNX");
  });

  it("reports a missing hint without charging", async () => {
    const store = await loadStore();
    mocks.upstashEval.mockResolvedValueOnce(["missing"]);
    const result = await store.revealHint("octocat", "juice-shop", "Challenge-999-Nope");
    expect(result).toEqual({ ok: false, missing: true, error: "No hint available for this challenge" });
  });

  it("rejects an unknown app before touching Upstash", async () => {
    const store = await loadStore();
    const result = await store.revealHint("octocat", "not-an-app", "Challenge-1");
    expect(result).toEqual({ ok: false, error: "Unknown app" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("rejects a malformed challenge id before touching Upstash", async () => {
    const store = await loadStore();
    const result = await store.revealHint("octocat", "juice-shop", "nope/../etc");
    expect(result).toEqual({ ok: false, error: "Invalid challenge id" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("refuses when hints are not enabled", async () => {
    const store = await loadStore(false);
    const result = await store.revealHint("octocat", "juice-shop", "Challenge-1");
    expect(result).toEqual({ ok: false, error: "Hints are not enabled" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  // Fail-direction pin (issue #232): a settings-read error must never let a
  // purchase through unpriced/ungated. getAdminSettings throws on both a
  // transport failure and a resolved per-command error (see AGENTS.md's
  // upstashPipeline gotcha) — either way this must refuse, never charge.
  it("fails CLOSED (rejects, never charges) when the settings read errors", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockRejectedValueOnce(new Error("redis down"));
    await expect(store.revealHint("octocat", "juice-shop", "Challenge-1")).rejects.toThrow("redis down");
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("is ON when the organizer has never touched the toggle — absent means default", async () => {
    const store = await loadStore();
    expect((await store.resolveHintConfig()).enabled).toBe(true);

    const off = await loadStore(false, { creds: true });
    expect((await off.resolveHintConfig()).enabled).toBe(false);
    const result = await off.revealHint("octocat", "juice-shop", "Challenge-1");
    expect(result).toEqual({ ok: false, error: "Hints are not enabled" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("stays off without Upstash creds even when the organizer switches hints ON — capability beats policy", async () => {
    const store = await loadStore(true, { creds: false });
    expect(store.HINTS_AVAILABLE).toBe(false);
    mocks.getAdminSettings.mockResolvedValue({ ...BASE_SETTINGS, hintsEnabled: true });
    expect((await store.resolveHintConfig()).enabled).toBe(false);
  });

  // The regression this whole change exists for: the /admin toggle used to
  // govern PURCHASING only, while these three read the env constant directly —
  // so switching hints off blocked buying but left the hint buttons on the
  // challenges page and the penalty column on the leaderboard.
  it("turns OFF every read path, not just purchasing, when the organizer switches hints off", async () => {
    // `getHintAvailability` swallows ANY error into `return {}`, and it reads
    // through `fetch` rather than the mocked pipeline — so asserting only on
    // its {} result passes even when the gate is missing and the un-mocked
    // fetch blows up. Spy on fetch and on console.error so the assertions
    // distinguish "refused because hints are off" from "tried and failed".
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not be called"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const off = await loadStore(false, { creds: true });
      expect(await off.getViewerHints("octocat")).toEqual({
        purchased: {},
        classic: {},
        ai: {},
        spent: 0,
        count: 0,
      });
      expect(await off.getHintPenalties()).toEqual(new Map());
      expect(await off.getHintAvailability()).toEqual({});
      // The decisive assertions: no read was even attempted, by either client.
      expect(mocks.upstashPipeline).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      consoleError.mockRestore();
    }
  });

  // Regression: /challenges called resolveHintConfig directly, which reads
  // admin settings, and upstashPipeline THROWS with no Upstash credentials —
  // so the page 500'd on any deployment without Redis. The unit tests missed
  // it because they mock getAdminSettings; the acceptance run caught it.
  it("getHintNotice never reads settings without Upstash creds — /challenges must not 500", async () => {
    const store = await loadStore(true, { creds: false });
    mocks.getAdminSettings.mockRejectedValue(new Error("UPSTASH_REDIS_REST_URL/TOKEN are not set"));
    await expect(store.getHintNotice()).resolves.toEqual({ active: false, cost: 10 });
    expect(mocks.getAdminSettings).not.toHaveBeenCalled();
  });

  it("keeps every read path ON when the organizer has set no override", async () => {
    const on = await loadStore();
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }, { result: null }]);
    await on.getViewerHints("octocat");
    expect(mocks.upstashPipeline).toHaveBeenCalled();
  });

  it("degrades to a friendly error when Upstash fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await loadStore();
    mocks.upstashEval.mockRejectedValueOnce(new Error("upstash down"));
    const result = await store.revealHint("octocat", "juice-shop", "Challenge-1");
    expect(result).toEqual({ ok: false, error: "Hint reveal failed. Try again" });
    consoleError.mockRestore();
  });
});

// The anti-burner gate: a throwaway account can eat the hint penalty and relay
// the text, so price alone can't stop hint farming — earned progress can.
describe("hintGate", () => {
  const settings = (over: Record<string, unknown> = {}) => ({
    paused: false,
    hintsEnabled: null,
    hintCost: null,
    hintsMinSolves: 1,
    hintsUnlockAfterMin: 0,
    scoringStartsAt: null,
    updatedBy: null,
    updatedAt: null,
    ...over,
  });
  /** HKEYS reply for ctf:solves:<target>: fields are `<author>:<challengeId>`. */
  const solves = (...fields: string[]) => mocks.upstashPipeline.mockResolvedValueOnce([{ result: fields }]);

  it("refuses outright when the secure-development module is disabled", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockImplementation(async (id) => id !== "secure-development");
    mocks.getAdminSettings.mockResolvedValue(settings({ hintsMinSolves: 0, hintsEnabled: true }));
    expect(await store.hintGate("octocat", "juice-shop")).toEqual({ allowed: false, reason: "disabled" });
    // Refuses on the module answer alone — makes no second read (settings or
    // Redis) once that answer is known.
    expect(mocks.getAdminSettings).not.toHaveBeenCalled();
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  // The module read fails OPEN to the deployment default inside
  // enabled-modules.ts on a settings-read failure — but that fallback lives
  // INSIDE isModuleLive. An unexpected throw escaping that wrapper (a bug, an
  // infra error) is a different case, and must not be swallowed into "live":
  // no charge may run and no hint may be revealed off the back of it.
  it("propagates a rejected live-module lookup instead of treating it as live", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockRejectedValueOnce(new Error("settings unreachable"));
    await expect(store.hintGate("alice", "classic")).rejects.toThrow("settings unreachable");
    // Bails before the config read — the gate never reaches resolveHintConfig.
    expect(mocks.getAdminSettings).not.toHaveBeenCalled();
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("charges nothing when the live-module lookup rejects", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockRejectedValueOnce(new Error("settings unreachable"));
    await expect(store.revealHint("alice", "classic", "web-robots-only")).rejects.toThrow(
      "settings unreachable",
    );
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("gates the ai target on the AI module directly, not secure-development", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockImplementation(async (id) => id === "secure-development");
    mocks.getAdminSettings.mockResolvedValue(settings({ hintsMinSolves: 0, hintsEnabled: true }));
    expect(await store.hintGate("octocat", "ai")).toEqual({ allowed: false, reason: "disabled" });
    // Refuses on the module answer alone — makes no second read (settings or
    // Redis) once that answer is known.
    expect(mocks.getAdminSettings).not.toHaveBeenCalled();
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();

    // Positive twin: ai on (secure-development irrelevant).
    mocks.isModuleLive.mockImplementation(async (id) => id === "ai");
    expect(await store.hintGate("octocat", "ai")).toEqual({ allowed: true });
  });

  it("counts ai solves with HLEN ctf:ai:solves:<login>, and the anti-burner gate consumes it", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue(settings());
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: 1 }]);
    expect(await store.hintGate("octocat", "ai")).toEqual({ allowed: true });
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([["HLEN", "ctf:ai:solves:octocat"]]);
  });

  it("blocks an account with no solves on the target (the burner case)", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue(settings());
    solves("someone-else:challenge-1");
    expect(await store.hintGate("burner", "juice-shop")).toEqual({
      allowed: false,
      reason: "no-progress",
      needed: 1,
      have: 0,
    });
  });

  it("allows an account that has earned a solve on that target", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue(settings());
    solves("octocat:challenge-1", "other:challenge-2");
    expect(await store.hintGate("octocat", "juice-shop")).toEqual({ allowed: true });
  });

  it("matches the login case-insensitively (GitHub logins are)", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue(settings());
    solves("OctoCat:challenge-1");
    expect(await store.hintGate("octocat", "juice-shop")).toEqual({ allowed: true });
  });

  it("counts solves per target, so progress elsewhere does not unlock this one", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue(settings({ hintsMinSolves: 2 }));
    solves("octocat:challenge-1"); // only one on this target
    expect(await store.hintGate("octocat", "juice-shop")).toMatchObject({
      allowed: false,
      reason: "no-progress",
      needed: 2,
      have: 1,
    });
  });

  it("locks every hint until the time phase opens", async () => {
    const store = await loadStore();
    const startsAt = new Date(Date.now() - 10 * 60_000).toISOString(); // started 10m ago
    mocks.getAdminSettings.mockResolvedValue(settings({ hintsUnlockAfterMin: 60, scoringStartsAt: startsAt }));
    const gate = await store.hintGate("octocat", "juice-shop");
    expect(gate).toMatchObject({ allowed: false, reason: "locked" });
    // Locked short-circuits before any solve lookup.
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("opens once the unlock delay has elapsed", async () => {
    const store = await loadStore();
    const startsAt = new Date(Date.now() - 90 * 60_000).toISOString(); // started 90m ago
    mocks.getAdminSettings.mockResolvedValue(settings({ hintsUnlockAfterMin: 60, scoringStartsAt: startsAt }));
    solves("octocat:challenge-1");
    expect(await store.hintGate("octocat", "juice-shop")).toEqual({ allowed: true });
  });

  it("ignores the time phase when no scoring start is configured", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue(settings({ hintsUnlockAfterMin: 60, scoringStartsAt: null }));
    solves("octocat:challenge-1");
    expect(await store.hintGate("octocat", "juice-shop")).toEqual({ allowed: true });
  });

  it("skips the progress gate entirely when hintsMinSolves is 0", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue(settings({ hintsMinSolves: 0 }));
    expect(await store.hintGate("burner", "juice-shop")).toEqual({ allowed: true });
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the solve lookup errors — a hint is a paid reveal", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue(settings());
    mocks.upstashPipeline.mockRejectedValueOnce(new Error("upstash down"));
    expect(await store.hintGate("octocat", "juice-shop")).toMatchObject({ allowed: false, reason: "no-progress" });
    consoleError.mockRestore();
  });

  it("revealHint enforces the gate and never reaches the charge script", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue(settings());
    solves("someone-else:challenge-1");
    const result = await store.revealHint("burner", "juice-shop", "Challenge-5-Admin-Section");
    expect(result).toMatchObject({ ok: false, forbidden: true });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });
});

describe("runtime hint override", () => {
  it("charges the overridden cost when set", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue({
      paused: false,
      hintsEnabled: null,
      hintCost: 25,
      hintsMinSolves: 0,
      hintsUnlockAfterMin: 0,
      scoringStartsAt: null,
      updatedBy: null,
      updatedAt: null,
    });
    mocks.upstashEval.mockResolvedValue(["charged", "the hint", 25]);
    const r = await store.revealHint("alice", "juice-shop", "Challenge-1-X");
    expect(r).toMatchObject({ ok: true, spent: 25 });
    const [, , args] = mocks.upstashEval.mock.calls[0];
    expect(args).toContain(25);
  });

  it("honors an enabled=false override even when the env default is on", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue({
      paused: false,
      hintsEnabled: false,
      hintCost: null,
      updatedBy: null,
      updatedAt: null,
    });
    const r = await store.revealHint("alice", "juice-shop", "Challenge-1-X");
    expect(r).toEqual({ ok: false, error: "Hints are not enabled" });
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("falls back to the baked default when no override is present", async () => {
    const store = await loadStore();
    mocks.getAdminSettings.mockResolvedValue({
      paused: false,
      hintsEnabled: null,
      hintCost: null,
      hintsMinSolves: 0,
      hintsUnlockAfterMin: 0,
      scoringStartsAt: null,
      updatedBy: null,
      updatedAt: null,
    });
    mocks.upstashEval.mockResolvedValue(["charged", "the hint", 10]);
    const r = await store.revealHint("alice", "juice-shop", "Challenge-1-X");
    expect(r).toMatchObject({ ok: true, spent: 10 });
  });
});

describe("isHintTarget", () => {
  it("accepts ai as a hint target", async () => {
    const store = await loadStore();
    expect(store.isHintTarget("ai")).toBe(true);
  });

  it("rejects a similar-looking string", async () => {
    const store = await loadStore();
    expect(store.isHintTarget("hints:ai")).toBe(false);
  });
});

describe("getAiHintIds", () => {
  it("returns the HKEYS of ctf:ai:hints when the ai module is enabled", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockImplementation(async (id) => id === "ai");
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["prompt-injection-1"] }]);
    expect(await store.getAiHintIds()).toEqual(["prompt-injection-1"]);
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([["HKEYS", "ctf:ai:hints"]]);
  });

  it("returns [] when the ai module is disabled", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockResolvedValue(false);
    expect(await store.getAiHintIds()).toEqual([]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  // Pins the fix: resolveHintConfig() (→ getAdminSettings) used to run
  // OUTSIDE the try, so a settings-read rejection escaped this function
  // entirely and rejected the Promise.all callers (the /ai and /flags pages)
  // run it under, 500ing the public board instead of degrading like every
  // other read here.
  it("degrades to [] when the settings read (resolveHintConfig) rejects", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockImplementation(async (id) => id === "ai");
    mocks.getAdminSettings.mockRejectedValueOnce(new Error("upstash down"));
    await expect(store.getAiHintIds()).resolves.toEqual([]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("getClassicHintIds", () => {
  it("returns the HKEYS of ctf:classic:hints when the classic module is enabled", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockImplementation(async (id) => id === "classic");
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["sql-injection-1"] }]);
    expect(await store.getClassicHintIds()).toEqual(["sql-injection-1"]);
    expect(mocks.upstashPipeline).toHaveBeenCalledWith([["HKEYS", "ctf:classic:hints"]]);
  });

  it("returns [] when the classic module is disabled", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockResolvedValue(false);
    expect(await store.getClassicHintIds()).toEqual([]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  // getAiHintIds' exact twin: same fix, same shape.
  it("degrades to [] when the settings read (resolveHintConfig) rejects", async () => {
    const store = await loadStore();
    mocks.isModuleLive.mockImplementation(async (id) => id === "classic");
    mocks.getAdminSettings.mockRejectedValueOnce(new Error("upstash down"));
    await expect(store.getClassicHintIds()).resolves.toEqual([]);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("getViewerHints", () => {
  it("resolves bought hints with their texts, grouped by app", async () => {
    const store = await loadStore();
    mocks.upstashPipeline
      .mockResolvedValueOnce([
        { result: ["juice-shop/Challenge-5-Admin-Section", "dvwa/brute-low"] },
        { result: "20" },
      ])
      .mockResolvedValueOnce([{ result: "Admin hint." }, { result: "Brute hint." }]);
    const result = await store.getViewerHints("octocat");
    expect(result).toEqual({
      purchased: {
        "juice-shop": { "Challenge-5-Admin-Section": "Admin hint." },
        dvwa: { "brute-low": "Brute hint." },
      },
      classic: {},
      ai: {},
      spent: 20,
      count: 2,
    });
  });

  // Both non-secure-dev buckets in one fixture: proves the parse routes
  // "classic/<id>" and "ai/<id>" into their own buckets rather than one
  // catch-all, alongside a member that goes to `purchased`.
  it("buckets a purchased ai hint into its own bucket, beside a classic one", async () => {
    const store = await loadStore();
    mocks.upstashPipeline
      .mockResolvedValueOnce([
        { result: ["classic/web-robots-only", "ai/prompt-injection-1"] },
        { result: "20" },
      ])
      .mockResolvedValueOnce([{ result: "Look at robots.txt." }, { result: "Ignore prior instructions." }]);
    const result = await store.getViewerHints("octocat");
    expect(result).toEqual({
      purchased: {},
      classic: { "web-robots-only": "Look at robots.txt." },
      ai: { "prompt-injection-1": "Ignore prior instructions." },
      spent: 20,
      count: 2,
    });
  });

  it("still counts a purchase whose hint text was later deleted", async () => {
    const store = await loadStore();
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: ["juice-shop/Challenge-Gone"] }, { result: "10" }])
      .mockResolvedValueOnce([{ result: null }]);
    const result = await store.getViewerHints("octocat");
    expect(result).toEqual({ purchased: {}, classic: {}, ai: {}, spent: 10, count: 1 });
  });

  it("skips malformed members and unknown apps", async () => {
    const store = await loadStore();
    mocks.upstashPipeline.mockResolvedValueOnce([
      { result: ["no-slash", "not-an-app/Challenge-1"] },
      { result: null },
    ]);
    const result = await store.getViewerHints("octocat");
    expect(result).toEqual({ purchased: {}, classic: {}, ai: {}, spent: 0, count: 0 });
    expect(mocks.upstashPipeline).toHaveBeenCalledTimes(1);
  });

  it("returns zeros when hints are not enabled", async () => {
    const store = await loadStore(false);
    expect(await store.getViewerHints("octocat")).toEqual({
      purchased: {},
      classic: {},
      ai: {},
      spent: 0,
      count: 0,
    });
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("getHintPenalties", () => {
  it("parses the spent hash into a login → points map", async () => {
    const store = await loadStore();
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["octocat", "30", "dcotelo", "10"] }]);
    const penalties = await store.getHintPenalties();
    expect(penalties).toEqual(new Map([["octocat", 30], ["dcotelo", 10]]));
  });

  it("drops non-numeric and non-positive values", async () => {
    const store = await loadStore();
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["a", "oops", "b", "0", "c", "10"] }]);
    expect(await store.getHintPenalties()).toEqual(new Map([["c", 10]]));
  });

  it("returns an empty map when hints are not enabled", async () => {
    const store = await loadStore(false);
    expect(await store.getHintPenalties()).toEqual(new Map());
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  // #523: an errored read of the spend hash is not "nobody bought a hint".
  it("throws when the spent-hash read fails, instead of reading it as no penalties", async () => {
    const store = await loadStore();
    mocks.upstashPipeline.mockResolvedValueOnce([{ error: "WRONGTYPE" }]);
    await expect(store.getHintPenalties()).rejects.toThrow(/hint penalties/);
  });
});

describe("getHintAvailability", () => {
  // It reads nothing now, and that is the fix (issue #334). `apps` is the
  // secure-development target list, so this function only ever described that
  // module — and nothing in the kit writes a `hints:<app>` field: not the
  // scorer, not the admin panel, not the rubrics. #313 fixed the transport
  // (an srh 404 on a path-style GET) and the tests here pinned the corrected
  // pipeline read; what neither caught is that there was never a producer on
  // the other end, so a working read could only ever come back empty while
  // /challenges reported that to contestants as news.
  it("returns {} without touching Redis", async () => {
    const store = await loadStore();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await store.getHintAvailability()).toEqual({});
    // The point of the change: no read at all, by either client.
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns {} with hints switched off too, still without reading", async () => {
    const store = await loadStore(false);
    expect(await store.getHintAvailability()).toEqual({});
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });
});

describe("the story lock on classic hints (#463)", () => {
  it("hands the script the prerequisite and the teammates' solves keys, and reports `locked` exactly as a missing hint", async () => {
    const store = await loadStore();
    storyMocks.listStories.mockResolvedValueOnce([{ id: "op", title: "Op", intro: "", steps: ["recon", "web"] }]);
    storyMocks.teamSolveKeys.mockResolvedValueOnce(["ctf:classic:solves:alice", "ctf:classic:solves:bob"]);
    mocks.upstashEval.mockResolvedValueOnce(["locked"]);
    const result = await store.revealHint("alice", "classic", "web");
    // No oracle (CodeRabbit #470): a locked step's hint is indistinguishable
    // from a challenge with no hint.
    expect(result).toEqual({ ok: false, missing: true, error: "No hint available for this challenge" });
    const [, keys, argv] = mocks.upstashEval.mock.calls.at(-1)!;
    expect(keys.slice(4)).toEqual(["ctf:classic:solves:alice", "ctf:classic:solves:bob"]);
    expect(argv[6]).toBe("recon");
  });

  it("refuses (closed) when the stories cannot be read, without running the script", async () => {
    const store = await loadStore();
    storyMocks.listStories.mockRejectedValueOnce(new Error("NOAUTH"));
    mocks.upstashEval.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await store.revealHint("alice", "classic", "web")).ok).toBe(false);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });
});

// #500 (S7): the four catch sites that used to hand `console.error` the caught
// value itself. A driver can decorate its error with the request it failed on
// (`command`, `cause`), and the reveal script's ARGV carries the login and the
// hint id, so each site must log `errorLabel(err)` and nothing else. Every case
// asserts BOTH that the log line happened (non-vacuous) and that the planted
// secret is absent from every argument, rendered deep.
describe("hint-store log redaction (#500)", () => {
  const SECRET = "PLANTED-hint-secret-7f3a";
  const decorated = () =>
    Object.assign(new Error("upstash down"), {
      command: ["EVAL", "...", SECRET],
      cause: new Error(`while sending ${SECRET}`),
    });

  async function logged(run: (store: HintStore) => Promise<unknown>): Promise<string> {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = await loadStore();
      await run(store);
      expect(consoleError).toHaveBeenCalled();
      // The label, never the caught value: a raw Error argument is exactly
      // what hands the logger its decorated `command` / `cause`.
      const errorArgs = consoleError.mock.calls.flat().filter((a) => a instanceof Error);
      expect(errorArgs).toEqual([]);
      return consoleError.mock.calls
        .map((args) => args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10, showHidden: true }))).join(" "))
        .join("\n");
    } finally {
      consoleError.mockRestore();
    }
  }

  it("hintGate's solve-lookup failure logs the label, not the error", async () => {
    const out = await logged(async (store) => {
      mocks.getAdminSettings.mockResolvedValue({ ...BASE_SETTINGS, hintsMinSolves: 1 });
      mocks.upstashPipeline.mockRejectedValueOnce(decorated());
      expect(await store.hintGate("octocat", "juice-shop")).toMatchObject({ allowed: false });
    });
    expect(out).toContain("upstash down");
    expect(out).not.toContain(SECRET);
  });

  it("revealHint's script failure logs the label, not the error", async () => {
    const out = await logged(async (store) => {
      mocks.upstashEval.mockRejectedValueOnce(decorated());
      expect(await store.revealHint("octocat", "juice-shop", "Challenge-1")).toEqual({
        ok: false,
        error: "Hint reveal failed. Try again",
      });
    });
    expect(out).toContain("upstash down");
    expect(out).not.toContain(SECRET);
  });

  it("getClassicHintIds' read failure logs the label, not the error", async () => {
    const out = await logged(async (store) => {
      mocks.upstashPipeline.mockRejectedValueOnce(decorated());
      expect(await store.getClassicHintIds()).toEqual([]);
    });
    expect(out).toContain("upstash down");
    expect(out).not.toContain(SECRET);
  });

  it("getAiHintIds' read failure logs the label, not the error", async () => {
    const out = await logged(async (store) => {
      mocks.upstashPipeline.mockRejectedValueOnce(decorated());
      expect(await store.getAiHintIds()).toEqual([]);
    });
    expect(out).toContain("upstash down");
    expect(out).not.toContain(SECRET);
  });
});
