// Runtime module enablement (issue #175), now on top of the default set
// derived from SCORE_IMAGE (issue #386). The property under test throughout:
// `ctf:admin:settings` is the live truth, and the default (secure-development
// iff a scorer image exists, else nothing) is only the SEED and the OUTAGE
// FALLBACK — see `@/lib/module-defaults`.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminSettings: vi.fn<() => Promise<{ enabledModuleIds: string[] | null }>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: mocks.getAdminSettings }));
// `react`'s real `cache()` only memoizes inside an actual RSC render; outside
// one (here) it would call straight through and the "one read per request"
// claim would go untested. Stand in a memoizer keyed on the wrapped function,
// the same shim `resolved-modules.test.ts` uses.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const memos = new WeakMap<(...args: never[]) => unknown, unknown>();
  return {
    ...actual,
    cache:
      <Fn extends (...args: never[]) => unknown>(fn: Fn): Fn =>
        ((...args: never[]) => {
          if (!memos.has(fn)) memos.set(fn, fn(...args));
          return memos.get(fn);
        }) as Fn,
  };
});

beforeEach(() => {
  mocks.getAdminSettings.mockReset();
  vi.resetModules();
});

async function load(env: Record<string, string | undefined>) {
  const prev = process.env.SCORE_IMAGE;
  if (env.SCORE_IMAGE === undefined) delete process.env.SCORE_IMAGE;
  else process.env.SCORE_IMAGE = env.SCORE_IMAGE;
  try {
    return await import("@/lib/enabled-modules");
  } finally {
    if (prev === undefined) delete process.env.SCORE_IMAGE;
    else process.env.SCORE_IMAGE = prev;
  }
}

describe("getEnabledModuleIds", () => {
  it("defaults to secure-development only when SCORE_IMAGE is set and nothing is stored", async () => {
    mocks.getAdminSettings.mockResolvedValue({ enabledModuleIds: null });
    const m = await load({ SCORE_IMAGE: "ghcr.io/x/score:latest" });
    expect([...(await m.getEnabledModuleIds())]).toEqual(["secure-development"]);
  });
  it("defaults to NOTHING when there is no scorer image and nothing is stored", async () => {
    mocks.getAdminSettings.mockResolvedValue({ enabledModuleIds: null });
    const m = await load({ SCORE_IMAGE: undefined });
    expect((await m.getEnabledModuleIds()).size).toBe(0);
  });
  it("uses the STORED set when there is one, whatever the default", async () => {
    mocks.getAdminSettings.mockResolvedValue({ enabledModuleIds: ["quiz", "classic"] });
    const m = await load({ SCORE_IMAGE: "ghcr.io/x/score:latest" });
    expect([...(await m.getEnabledModuleIds())].sort()).toEqual(["classic", "quiz"]);
  });
  it("honours an explicitly EMPTY stored set — an organizer switched everything off", async () => {
    mocks.getAdminSettings.mockResolvedValue({ enabledModuleIds: [] });
    const m = await load({ SCORE_IMAGE: "ghcr.io/x/score:latest" });
    expect((await m.getEnabledModuleIds()).size).toBe(0);
  });
  it("falls back to the DEFAULT set when the settings read fails (fail open)", async () => {
    mocks.getAdminSettings.mockRejectedValue(new Error("NOAUTH"));
    const m = await load({ SCORE_IMAGE: "ghcr.io/x/score:latest" });
    expect([...(await m.getEnabledModuleIds())]).toEqual(["secure-development"]);
  });

  // Final-review finding #1, part 1: a deployment can have secure-development
  // in its STORED set (carried over from when a scorer image existed) while
  // SCORE_IMAGE is unset today. Serving it would show a board no run can ever
  // score — narrow it out on the read side, unconditionally.
  it("narrows secure-development out of a stored set when there is no scorer image", async () => {
    mocks.getAdminSettings.mockResolvedValue({ enabledModuleIds: ["secure-development", "quiz"] });
    const m = await load({ SCORE_IMAGE: undefined });
    expect([...(await m.getEnabledModuleIds())]).toEqual(["quiz"]);
  });

  it("calls getAdminSettings once per request, however many times the module set is awaited", async () => {
    mocks.getAdminSettings.mockResolvedValue({ enabledModuleIds: ["quiz"] });
    const m = await load({ SCORE_IMAGE: undefined });
    await m.getEnabledModuleIds();
    await m.getEnabledModuleIds();
    expect(mocks.getAdminSettings).toHaveBeenCalledTimes(1);
  });

  // CodeRabbit round 1, finding A: `getResolvedModules` (in
  // `@/lib/resolved-modules`) used to read `getAdminSettings()` on its own,
  // independently of this module's `getEnabledModuleIds` — two settings
  // reads per request that could disagree on an unlucky Redis blip. Both now
  // funnel through `getAdminSettingsSnapshot` here, so a request that calls
  // both costs exactly the one read this whole file otherwise pins per
  // function. `@/lib/resolved-modules` is imported for real (not mocked) so
  // this exercises the actual shared dependency, not a stand-in for it.
  it("costs ONE getAdminSettings read across getEnabledModuleIds and getResolvedModules in the same request", async () => {
    mocks.getAdminSettings.mockResolvedValue({ enabledModuleIds: ["quiz"] });
    const m = await load({ SCORE_IMAGE: undefined });
    const { getResolvedModules } = await import("@/lib/resolved-modules");

    await m.getEnabledModuleIds();
    await getResolvedModules();

    expect(mocks.getAdminSettings).toHaveBeenCalledTimes(1);
  });
});

describe("isModuleLive", () => {
  it("answers off the stored set", async () => {
    mocks.getAdminSettings.mockResolvedValue({ enabledModuleIds: ["classic"] });
    const m = await load({ SCORE_IMAGE: undefined });
    expect(await m.isModuleLive("classic")).toBe(true);
    expect(await m.isModuleLive("quiz")).toBe(false);
  });
});
