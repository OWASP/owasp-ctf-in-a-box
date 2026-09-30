// Integration tests: exercises the REAL reveal Lua script against a live Redis
// (srh in CI, Upstash or srh locally), because that's where charge-once
// idempotency is actually enforced (atomically). Injects a run-unique field
// into hints:juice-shop, a run-unique solve into ctf:solves:juice-shop and
// uses a run-unique login; everything is cleaned up before and after.
//
// The reveal path reads the organizer's runtime settings (ctf:admin:settings,
// via resolveHintConfig/hintGate) before it ever reaches the script: hints
// on/off, the price, the anti-burner gate (solves on the target before its
// hints can be bought) and the unlock-after phase. This suite writes those
// four explicitly, through the store's own updateAdminSettings, so it pins
// what the reveal does under a KNOWN policy rather than whatever the previous
// run (or the admin-store suite, which writes hintCost 25) left behind — and
// then EARNS its way through the gate by seeding a solve, so the gate is
// exercised, not switched off. That is what rotted the previous version of
// this suite (#235): it seeded no solve and no settings, and every reveal was
// refused by the default one-solve gate.
//
// Gating comes from live-redis.ts: skipped without the env, a FAILURE when
// CTF_LUA_SUITES_REQUIRED is set. The suite shares ctf:admin:settings with
// the admin-store suite, so the live run is serial (see ci.yml).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RUN, liveConfigured } from "./live-redis";

vi.mock("server-only", () => ({}));
// The real `isModuleLive` calls `connection()` to stay out of Next's
// build-time prerender, which throws outside a request scope — there is none
// here, this is a direct function call from a test. Stood in for with a
// secure-development-only set: secure-development live, quiz/classic/ai not — see the note by the availability test below for
// why their gates are out of scope here.
vi.mock("@/lib/enabled-modules", () => ({
  isModuleLive: async (id: string) => id === "secure-development",
}));

const PLAYER = `vt-${RUN}-hints-p1`;
const TARGET = "juice-shop";
const HINT_ID = `vt-${RUN}-challenge`;
const HINT_TEXT = `throwaway hint for test run ${RUN}`;
const HINT_HASH = `hints:${TARGET}`;
const SOLVES_HASH = `ctf:solves:${TARGET}`;
// The scorer's solve row shape: `<author>:<challengeId>`; only the field
// name is read by the gate, so the value is a placeholder.
const SOLVE_FIELD = `${PLAYER}:vt-${RUN}-solved`;
/** Deliberately NOT the baked HINT_COST, and not the 25 the admin-store suite
 *  writes: the assertions below hold only if the organizer's configured price
 *  is what the script actually charges. */
const COST = 15;
const HINT_SETTINGS = ["hintsEnabled", "hintCost", "hintsMinSolves", "hintsUnlockAfterMin"];

describe.skipIf(!liveConfigured)("hint store against a live Redis (throwaway keys)", () => {
  let store: typeof import("@/lib/hint-store");
  let admin: typeof import("@/lib/admin-store");
  let pipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  async function cleanup() {
    await pipeline([
      ["HDEL", HINT_HASH, HINT_ID],
      ["HDEL", SOLVES_HASH, SOLVE_FIELD],
      ["HDEL", "ctf:hints:spent", PLAYER],
      ["DEL", `ctf:user:${PLAYER}:hints`],
      ["DEL", `ctf:hints:at:${PLAYER}`],
    ]);
  }

  beforeAll(async () => {
    store = await import("@/lib/hint-store");
    admin = await import("@/lib/admin-store");
    ({ upstashPipeline: pipeline } = await import("@/lib/upstash"));
    await cleanup();
    await admin.updateAdminSettings(
      { hintsEnabled: true, hintCost: COST, hintsMinSolves: 1, hintsUnlockAfterMin: 0 },
      `vitest-${RUN}`,
    );
    await pipeline([["HSET", HINT_HASH, HINT_ID, HINT_TEXT]]);
  });

  afterAll(async () => {
    await cleanup();
    // Back to "no override" — the neutral state, not the values we chose.
    await pipeline([["HDEL", "ctf:admin:settings", ...HINT_SETTINGS]]);
  });

  it("resolves the seeded policy, not the baked defaults", async () => {
    const config = await store.resolveHintConfig();
    expect(config).toMatchObject({ enabled: true, cost: COST, minSolves: 1, unlockAfterMin: 0 });
  });

  it("refuses a player with no solves on the target and charges nothing", async () => {
    const result = await store.revealHint(PLAYER, TARGET, HINT_ID);
    expect(result).toEqual({
      ok: false,
      forbidden: true,
      error: "Solve 1 challenge on this target before buying its hints (you have 0)",
    });
    const [spent, owned] = await pipeline([
      ["HGET", "ctf:hints:spent", PLAYER],
      ["SCARD", `ctf:user:${PLAYER}:hints`],
    ]);
    expect(spent.result).toBeNull();
    expect(owned.result).toBe(0);
  });

  // #464 admin preview: the SAME script, told to write nothing — the text comes
  // back, nothing is charged or recorded, and the unlock gates do not apply
  // (a preview happens before launch). The next test, which charges, is the
  // anti-vacuous half: the same reveal without dry run DOES write.
  it("a dry-run (preview) reveal returns the text and charges nothing", async () => {
    const result = await store.revealHint(PLAYER, TARGET, HINT_ID, { dryRun: true });
    expect(result).toEqual({ ok: true, hint: HINT_TEXT, alreadyOwned: false, spent: 0, dryRun: true });
    const [spent, owned, at] = await pipeline([
      ["HGET", "ctf:hints:spent", PLAYER],
      ["SCARD", `ctf:user:${PLAYER}:hints`],
      ["HLEN", `ctf:hints:at:${PLAYER}`],
    ]);
    expect(spent.result).toBeNull();
    expect(owned.result).toBe(0);
    expect(at.result).toBe(0);
  });

  it("charges the first reveal once the gate is earned", async () => {
    await pipeline([["HSET", SOLVES_HASH, SOLVE_FIELD, new Date().toISOString()]]);
    const result = await store.revealHint(PLAYER, TARGET, HINT_ID);
    expect(result).toEqual({
      ok: true,
      hint: HINT_TEXT,
      alreadyOwned: false,
      spent: COST,
    });
  });

  it("returns the second reveal for free — spent is unchanged", async () => {
    const result = await store.revealHint(PLAYER, TARGET, HINT_ID);
    expect(result).toEqual({
      ok: true,
      hint: HINT_TEXT,
      alreadyOwned: true,
      spent: COST,
    });
    const [spent] = await pipeline([["HGET", "ctf:hints:spent", PLAYER]]);
    expect(Number(spent.result)).toBe(COST);
  });

  it("reports the purchase in the viewer state and penalty map", async () => {
    const viewer = await store.getViewerHints(PLAYER);
    expect(viewer.purchased[TARGET]?.[HINT_ID]).toBe(HINT_TEXT);
    expect(viewer.spent).toBe(COST);
    expect(viewer.count).toBe(1);

    const penalties = await store.getHintPenalties();
    expect(penalties.get(PLAYER)).toBe(COST);
  });

  it("refuses to charge for a hint that does not exist", async () => {
    const result = await store.revealHint(PLAYER, TARGET, `vt-${RUN}-no-such-hint`);
    expect(result).toEqual({ ok: false, missing: true, error: "No hint available for this challenge" });
    const [spent] = await pipeline([["HGET", "ctf:hints:spent", PLAYER]]);
    expect(Number(spent.result)).toBe(COST);
  });

  // The board's 💡 layer, against the real proxy.
  //
  // This used to assert the opposite: that a seeded `hints:<target>` hash came
  // back marked. That was the right test for the transport bug it was written
  // for (#313 — `getHintAvailability` called Upstash's path-style
  // `GET /hkeys/<key>`, which srh answers `404 SRH: Endpoint not found`, and the
  // mocked suite stubbed `fetch` to return `ok: true` so it proved a request
  // was made and never that the route existed).
  //
  // Fixing the transport revealed there was never a PRODUCER: nothing in this
  // kit writes a `hints:<app>` field — not the scorer, not the admin panel, not
  // the rubrics — so the read could only ever come back empty while
  // /challenges reported that to contestants as news (#334). Secure
  // Development is out of the availability read now, and this pins that: even
  // with a hash seeded by hand, nothing is marked.
  it("marks nothing for secure-development, even with a hash seeded by hand", async () => {
    // The seed is real — `revealHint` above charges against this very hash, so
    // the key exists and carries HINT_ID. Availability is still empty, because
    // the module has no hints to advertise rather than because the read failed.
    const [seeded] = await pipeline([["HGET", `hints:${TARGET}`, HINT_ID]]);
    expect(seeded.result).toBeTruthy();

    const availability = await store.getHintAvailability();
    expect(availability).toEqual({});
  });

  // Not asserted here: that classic and ai hint reads still work. Both gate on
  // `isModuleLive`, and this suite runs against a secure-development-only set
  // where neither module is on, so a live assertion would only ever exercise
  // the module gate — a skip dressed as a check. Their reads are covered by the
  // mocked suite and by the classic/ai store suites that do enable them.

  // #463: a locked story step's hint is refused INSIDE the reveal script —
  // before any charge — unless a teammate (a solves hash handed in as
  // KEYS[5..]) holds the prerequisite. Run on throwaway keys.
  it("REVEAL_SCRIPT refuses a locked story step's hint, charging nothing, and reveals it once a teammate solved the prerequisite", async () => {
    const { REVEAL_SCRIPT } = await import("@/lib/hint-store");
    const { upstashEval } = await import("@/lib/upstash");
    const k = (n: string) => `ctf-test:hint-lock:${RUN}:${n}`;
    const [set, spent, hints, at, teammate] = ["set", "spent", "hints", "at", "bob"].map(k);
    await pipeline([["HSET", hints, "web", "look at the cookie"]]);
    const reveal = () =>
      upstashEval(REVEAL_SCRIPT, [set, spent, hints, at, teammate], ["web", "classic/web", "alice", 10, "2026-10-01T00:00:00Z", "0", "recon"]);

    expect(await reveal()).toEqual(["locked"]);
    const [s1, sp1] = await pipeline([["SCARD", set], ["HGET", spent, "alice"]]);
    expect(s1.result).toBe(0);
    expect(sp1.result).toBeNull();

    await pipeline([["HSET", teammate, "recon", '{"points":1,"at":"x"}']]);
    expect(await reveal()).toEqual(["charged", "look at the cookie", 10]);
    await pipeline([["DEL", set, spent, hints, at, teammate]]);
  });

  // CodeRabbit #470: the lock comes BEFORE the hint read — a locked step with
  // no hint at all answers `locked`, not `missing`.
  it("REVEAL_SCRIPT checks the lock before reading the hint", async () => {
    const { REVEAL_SCRIPT } = await import("@/lib/hint-store");
    const { upstashEval } = await import("@/lib/upstash");
    const k = (n: string) => `ctf-test:hint-lock2:${RUN}:${n}`;
    const [set, spent, hints, at, teammate] = ["set", "spent", "hints", "at", "bob"].map(k);
    expect(
      await upstashEval(REVEAL_SCRIPT, [set, spent, hints, at, teammate], ["nohint", "classic/nohint", "alice", 10, "2026-10-01T00:00:00Z", "0", "recon"]),
    ).toEqual(["locked"]);
  });
});
