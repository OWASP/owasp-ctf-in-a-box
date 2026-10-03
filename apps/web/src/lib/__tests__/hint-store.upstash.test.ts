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
// The affordability gate (#553) reads the FOLDED leaderboard, which needs a
// scorer and every module's stores — none of which this suite stands up. It
// pins the Lua script and the settings gates, so the balance is stood in for
// with a contestant who can afford anything; hint-balance.test.ts and
// hint-store.test.ts cover the gate itself.
// Hoisted and mutable so the concurrency test below can narrow it to "affords
// exactly one hint" and restore it. The REVISION is not stubbed: the stub
// reads the live `ctf:admin:score-rev` the way the real hintBalance does, so
// the script's stale check runs for real here (the settings write in
// beforeAll bumps it; a frozen "0" would make every reveal `stale`).
const balanceRef = vi.hoisted(() => ({ value: { gross: 1000, spent: 0, net: 1000 } }));
const BALANCE = balanceRef.value;
vi.mock("@/lib/hint-balance", async () => {
  const { currentScoreRevision } = await import("@/lib/leaderboard/fold-cache");
  return { hintBalance: async () => ({ ...balanceRef.value, rev: await currentScoreRevision() }) };
});

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
    expect(result).toEqual({ ok: true, hint: HINT_TEXT, alreadyOwned: false, spent: 0, cost: COST, dryRun: true });
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
      cost: COST,
      // The resulting score (#553): the stood-in net less what was charged.
      balance: BALANCE.net - COST,
    });
  });

  it("returns the second reveal for free — spent is unchanged", async () => {
    const result = await store.revealHint(PLAYER, TARGET, HINT_ID);
    expect(result).toEqual({
      ok: true,
      hint: HINT_TEXT,
      alreadyOwned: true,
      spent: COST,
      cost: COST,
      // A re-view charges nothing: the script reports the same total as the
      // charge did, so the net is unchanged from after the purchase.
      balance: BALANCE.gross - COST,
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
  // #553 review: the gate's balance read and the script's charge are two
  // round-trips, so two parallel reveals could both pass the gate on the same
  // spend and both charge. The script re-checks `gross − spent ≥ cost`
  // atomically before its SADD, so of two simultaneous purchases against a
  // balance that covers ONE, exactly one lands — the other gets the same 403
  // the gate would have given, from the spend the script actually saw.
  it("REVEAL_SCRIPT lets exactly one of two concurrent reveals charge when the balance covers one", async () => {
    const P2 = `vt-${RUN}-hints-p2`;
    const ID_A = `vt-${RUN}-race-a`;
    const ID_B = `vt-${RUN}-race-b`;
    const P2_SOLVE = `${P2}:vt-${RUN}-solved`;
    const prior = balanceRef.value;
    balanceRef.value = { gross: COST, spent: 0, net: COST }; // affords exactly one hint
    try {
      await pipeline([
        ["HSET", HINT_HASH, ID_A, "a"],
        ["HSET", HINT_HASH, ID_B, "b"],
        ["HSET", SOLVES_HASH, P2_SOLVE, new Date().toISOString()],
      ]);
      const [a, b] = await Promise.all([store.revealHint(P2, TARGET, ID_A), store.revealHint(P2, TARGET, ID_B)]);
      const outcomes = [a, b].map((r) => (r.ok ? "charged" : r.error)).sort();
      expect(outcomes).toEqual([`Not enough points: this hint costs ${COST} and you have 0`, "charged"]);
      const [spent, owned] = await pipeline([
        ["HGET", "ctf:hints:spent", P2],
        ["SCARD", `ctf:user:${P2}:hints`],
      ]);
      expect(Number(spent.result)).toBe(COST);
      expect(owned.result).toBe(1);
    } finally {
      balanceRef.value = prior;
      await pipeline([
        ["HDEL", HINT_HASH, ID_A, ID_B],
        ["HDEL", SOLVES_HASH, P2_SOLVE],
        ["HDEL", "ctf:hints:spent", P2],
        ["DEL", `ctf:user:${P2}:hints`],
        ["DEL", `ctf:hints:at:${P2}`],
      ]);
    }
  });

  it("REVEAL_SCRIPT refuses a locked story step's hint, charging nothing, and reveals it once a teammate solved the prerequisite", async () => {
    const { REVEAL_SCRIPT } = await import("@/lib/hint-store");
    const { upstashEval } = await import("@/lib/upstash");
    const k = (n: string) => `ctf-test:hint-lock:${RUN}:${n}`;
    // KEYS[5..6] are the score revision and the in-progress counter (#553);
    // the lock keys follow them.
    const [set, spent, hints, at, rev, lowering, teammate] = ["set", "spent", "hints", "at", "rev", "lowering", "bob"].map(k);
    await pipeline([["HSET", hints, "web", "look at the cookie"]]);
    const reveal = () =>
      upstashEval(REVEAL_SCRIPT, [set, spent, hints, at, rev, lowering, teammate], ["web", "classic/web", "alice", 10, "2026-10-01T00:00:00Z", "0", "recon", "", ""]);

    expect(await reveal()).toEqual(["locked"]);
    const [s1, sp1] = await pipeline([["SCARD", set], ["HGET", spent, "alice"]]);
    expect(s1.result).toBe(0);
    expect(sp1.result).toBeNull();

    await pipeline([["HSET", teammate, "recon", '{"points":1,"at":"x"}']]);
    expect(await reveal()).toEqual(["charged", "look at the cookie", 10]);
    await pipeline([["DEL", set, spent, hints, at, rev, lowering, teammate]]);
  });

  // #553 review: the gross the gate folded can be outdated by a write on
  // ANOTHER app task while the fold ran. The gross therefore travels with the
  // score revision it was folded under, and the script refuses — before it
  // reads the spend or charges — when the revision has moved, or while a
  // score-lowering operation is still running (the in-progress counter).
  it("REVEAL_SCRIPT refuses a gross folded under a moved revision, or during a score-lowering op, charging nothing", async () => {
    const { REVEAL_SCRIPT } = await import("@/lib/hint-store");
    const { upstashEval } = await import("@/lib/upstash");
    const k = (n: string) => `ctf-test:hint-rev:${RUN}:${n}`;
    const [set, spent, hints, at, rev, lowering] = ["set", "spent", "hints", "at", "rev", "lowering"].map(k);
    try {
      await pipeline([["HSET", hints, "web", "x"], ["SET", rev, "5"]]);
      // ARGV[8] = gross 100 (affordable), ARGV[9] = the revision the gross was folded under.
      const revealWithRev = (revSeen: string) =>
        upstashEval(REVEAL_SCRIPT, [set, spent, hints, at, rev, lowering], ["web", "classic/web", "alice", 10, "2026-10-01T00:00:00Z", "0", "", "100", revSeen]);
      expect(await revealWithRev("4")).toEqual(["stale"]);
      // The current revision, but an operation in progress: still refused.
      await pipeline([["SET", lowering, "1"]]);
      expect(await revealWithRev("5")).toEqual(["stale"]);
      const [s1, sp1] = await pipeline([["SCARD", set], ["HGET", spent, "alice"]]);
      expect(s1.result).toBe(0);
      expect(sp1.result).toBeNull();
      // Operation over (counter back to 0), current revision: charges.
      await pipeline([["SET", lowering, "0"]]);
      expect(await revealWithRev("5")).toEqual(["charged", "x", 10]);
      // Absent keys read as "0" — a gross folded under "0" with nothing running passes.
      await pipeline([["DEL", rev, lowering, set, spent, at]]);
      expect(await revealWithRev("0")).toEqual(["charged", "x", 10]);
    } finally {
      await pipeline([["DEL", set, spent, hints, at, rev, lowering]]);
    }
  });

  // CodeRabbit #470: the lock comes BEFORE the hint read — a locked step with
  // no hint at all answers `locked`, not `missing`.
  it("REVEAL_SCRIPT checks the lock before reading the hint", async () => {
    const { REVEAL_SCRIPT } = await import("@/lib/hint-store");
    const { upstashEval } = await import("@/lib/upstash");
    const k = (n: string) => `ctf-test:hint-lock2:${RUN}:${n}`;
    const [set, spent, hints, at, rev, lowering, teammate] = ["set", "spent", "hints", "at", "rev", "lowering", "bob"].map(k);
    expect(
      await upstashEval(REVEAL_SCRIPT, [set, spent, hints, at, rev, lowering, teammate], ["nohint", "classic/nohint", "alice", 10, "2026-10-01T00:00:00Z", "0", "recon", "", ""]),
    ).toEqual(["locked"]);
  });
});
