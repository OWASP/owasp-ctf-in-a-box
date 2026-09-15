import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(s: string, k: string[], a: (string | number)[]) => Promise<unknown>>(),
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: mocks.upstashEval, upstashPipeline: mocks.upstashPipeline }));

import {
  AdminValidationError,
  effectivePaused,
  effectiveRegistrationOpen,
  getAdminSettings,
  getSyncStatus,
  outsideWindow,
  updateAdminSettings,
  type AdminSettings,
} from "@/lib/admin-store";
import { TEAM_MAX_MEMBERS_MAX } from "@/lib/team-limits";
import { SECURE_DEV_TARGETS_MESSAGE } from "@/lib/secure-dev-targets";

beforeEach(() => {
  mocks.upstashEval.mockReset();
  mocks.upstashPipeline.mockReset();
});

describe("getAdminSettings", () => {
  it("fills defaults for an empty hash", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }]);
    expect(await getAdminSettings()).toEqual({
      paused: false, hintsEnabled: null, hintCost: null, teamRegistrationOpen: true,
      hintsMinSolves: null, hintsUnlockAfterMin: null,
      quizMaxAttempts: null, quizRetryAfterMin: null, classicCooldownSec: null, aiCooldownSec: null, teamMaxMembers: null, scoreCooldownMin: null,
      scoringStartsAt: null, scoringEndsAt: null, registrationStartsAt: null, registrationEndsAt: null,
      updatedBy: null, updatedAt: null, moduleOverrides: {},
  enabledModuleIds: null, eventIdentity: {}, secureDevTargets: null, sponsorLogoSize: null,
    });
  });

  it("throws on a resolved per-command error instead of decoding it as defaults", async () => {
    // upstashPipeline resolves with { error } for a command-level failure —
    // it only rejects on transport trouble. Decoding the missing result as an
    // empty hash would silently serve default settings (not paused, baked
    // caps) with no log, bypassing every caller's documented fail direction.
    // Throwing makes a command error behave exactly like the transport error
    // each caller already handles.
    mocks.upstashPipeline.mockResolvedValue([{ error: "NOAUTH Authentication required." }]);
    await expect(getAdminSettings()).rejects.toThrow("NOAUTH");
  });

  // Runtime module enablement (issue #175). Stored as a comma-separated id
  // list; the decoder is what stands between a stale or hand-edited field and
  // an event that serves nothing.
  it("decodes a stored module set", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["enabledModules", "quiz,classic"] }]);
    expect((await getAdminSettings()).enabledModuleIds).toEqual(["quiz", "classic"]);
  });

  it("drops ids the registry does not know, keeping the rest", async () => {
    // A module removed from the registry must not be able to re-enable itself
    // out of stale state — it has no route, no nav entry and no tab, so
    // honouring it would enable something that cannot render.
    mocks.upstashPipeline.mockResolvedValue([{ result: ["enabledModules", "quiz,not-a-module"] }]);
    expect((await getAdminSettings()).enabledModuleIds).toEqual(["quiz"]);
  });

  it("reads a set that filters down to nothing as NO OVERRIDE, not as nothing-enabled", async () => {
    // The fail-open rule, at the decoder. A field naming only unknown ids has
    // to mean "I can't use this, use the baked set" — decoding it to an empty
    // array would hand the resolver a legitimate-looking "enable nothing" and
    // 404 the whole event off one stale string.
    mocks.upstashPipeline.mockResolvedValue([{ result: ["enabledModules", "not-a-module,also-not"] }]);
    expect((await getAdminSettings()).enabledModuleIds).toBeNull();
  });

  it("tolerates whitespace and duplicates", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["enabledModules", " quiz , quiz,  classic "] }]);
    expect((await getAdminSettings()).enabledModuleIds).toEqual(["quiz", "classic"]);
  });

  it("reads an empty string as an EXPLICITLY empty set, not as no override", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["enabledModules", ""] }]);
    const s = await getAdminSettings();
    expect(s.enabledModuleIds).toEqual([]);
  });
  it("reads an absent field as null — nothing stored, the default applies", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }]);
    const s = await getAdminSettings();
    expect(s.enabledModuleIds).toBeNull();
  });

  it("decodes a populated hash, treating overrides as present", async () => {
    mocks.upstashPipeline.mockResolvedValue([{
      result: ["paused", "1", "hintsEnabled", "0", "hintCost", "25", "updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z"],
    }]);
    expect(await getAdminSettings()).toEqual({
      paused: true, hintsEnabled: false, hintCost: 25, teamRegistrationOpen: true,
      hintsMinSolves: null, hintsUnlockAfterMin: null,
      quizMaxAttempts: null, quizRetryAfterMin: null, classicCooldownSec: null, aiCooldownSec: null, teamMaxMembers: null, scoreCooldownMin: null,
      scoringStartsAt: null, scoringEndsAt: null, registrationStartsAt: null, registrationEndsAt: null,
      updatedBy: "alice", updatedAt: "2026-08-14T00:00:00Z", moduleOverrides: {},
      // Absent from the hash => null => "no override, use the baked set".
      enabledModuleIds: null,
      eventIdentity: {},
      secureDevTargets: null,
      sponsorLogoSize: null,
    });
  });

  it("decodes a stored \"0\" for teamRegistrationOpen as closed", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["teamRegistrationOpen", "0"] }]);
    expect((await getAdminSettings()).teamRegistrationOpen).toBe(false);
  });

  // Secure-development targets (issue #386, PR 2) — decoded through
  // normalizeSecureDevTargets, same contract as its own unit tests: known ids
  // only, deduplicated, in catalogue order; anything that survives to nothing
  // decodes to null ("no override, use the default"), same reading as
  // enabledModuleIds' unknown-only case above.
  it("decodes a stored secureDevTargets list, reordered to catalogue order", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["secureDevTargets", '["vampi","dvwa"]'] }]);
    expect((await getAdminSettings()).secureDevTargets).toEqual(["dvwa", "vampi"]);
  });

  it("decodes an empty stored secureDevTargets list as null — no override, use the default", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["secureDevTargets", "[]"] }]);
    expect((await getAdminSettings()).secureDevTargets).toBeNull();
  });

  it("decodes garbage secureDevTargets as null rather than throwing", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["secureDevTargets", "not-json"] }]);
    expect((await getAdminSettings()).secureDevTargets).toBeNull();
  });
});

describe("updateAdminSettings validation", () => {
  it("rejects a negative hint cost before touching Redis", async () => {
    await expect(updateAdminSettings({ hintCost: -1 }, "alice")).rejects.toBeInstanceOf(AdminValidationError);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("rejects an out-of-bound hint cost", async () => {
    await expect(updateAdminSettings({ hintCost: 999999 }, "alice")).rejects.toBeInstanceOf(AdminValidationError);
  });

  // Runtime module enablement (issue #386). Every module but
  // secure-development toggles freely, including down to an explicit empty
  // set; secure-development is the one id gated on SCORE_IMAGE, since it
  // needs the scorer and sync containers that only exist when one is set.
  describe("enabledModules", () => {
    afterEach(() => {
      delete process.env.SCORE_IMAGE;
    });

    it("accepts adding a module the baked config never mentioned", async () => {
      process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";
      mocks.upstashEval.mockResolvedValue([]);
      await updateAdminSettings({ enabledModules: ["secure-development", "quiz"] }, "alice");
      const args = mocks.upstashEval.mock.calls[0][2];
      expect(args).toContain("secure-development,quiz");
    });

    it("accepts an empty set — an organizer may switch every board off", async () => {
      mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z", "enabledModules", ""]);
      const s = await updateAdminSettings({ enabledModules: [] }, "alice");
      const [, , args] = mocks.upstashEval.mock.calls[0];
      const strArgs = args.map(String);
      const idx = strArgs.indexOf("enabledModules");
      expect(strArgs[idx + 1]).toBe(""); // stored as "", which decodes to []
      expect(s.enabledModuleIds).toEqual([]);
    });

    it("accepts disabling secure-development", async () => {
      mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z"]);
      await expect(updateAdminSettings({ enabledModules: ["quiz"] }, "alice")).resolves.toBeDefined();
    });

    it("accepts enabling secure-development when a scorer image exists", async () => {
      process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";
      mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z"]);
      await expect(
        updateAdminSettings({ enabledModules: ["secure-development", "quiz"] }, "alice"),
      ).resolves.toBeDefined();
    });

    it("refuses enabling secure-development when it is not already stored and there is no scorer image", async () => {
      delete process.env.SCORE_IMAGE;
      mocks.upstashPipeline.mockResolvedValue([{ result: ["enabledModules", "quiz"] }]);
      await expect(
        updateAdminSettings({ enabledModules: ["secure-development"] }, "alice"),
      ).rejects.toBeInstanceOf(AdminValidationError);
      expect(mocks.upstashEval).not.toHaveBeenCalled();
    });

    it("refuses enabling secure-development when the current-settings read itself fails (fail closed)", async () => {
      delete process.env.SCORE_IMAGE;
      mocks.upstashPipeline.mockResolvedValue([{ error: "NOAUTH Authentication required." }]);
      await expect(
        updateAdminSettings({ enabledModules: ["secure-development"] }, "alice"),
      ).rejects.toBeInstanceOf(AdminValidationError);
      expect(mocks.upstashEval).not.toHaveBeenCalled();
    });

    // CodeRabbit round 1, finding B (ruling): secure-development is NEVER
    // WRITTEN when unavailable, carried-forward or not. A deployment can
    // already have it STORED (from when it had a scorer image) even after
    // SCORE_IMAGE is removed; refusing the whole write would deadlock the
    // Modules section the same way an unconditional refusal always did — so
    // this does not refuse, it STRIPS the id from what actually gets
    // written. The stale-read race this closes: a concurrent SD-disable
    // landing between the read below and this write can at worst turn a
    // strip into a refusal (next time), never re-store secure-development as
    // live — stripping never depends on the read succeeding, it only ever
    // removes the id.
    it("strips a stored secure-development from what is written when there is no scorer image today", async () => {
      delete process.env.SCORE_IMAGE;
      mocks.upstashPipeline.mockResolvedValue([{ result: ["enabledModules", "secure-development,classic"] }]);
      mocks.upstashEval.mockResolvedValue([
        "updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z", "enabledModules", "quiz",
      ]);
      await expect(
        updateAdminSettings({ enabledModules: ["secure-development", "quiz"] }, "alice"),
      ).resolves.toBeDefined();
      const [, , args] = mocks.upstashEval.mock.calls[0];
      const strArgs = args.map(String);
      const idx = strArgs.indexOf("enabledModules");
      expect(strArgs[idx + 1]).toBe("quiz");
      expect(args).not.toContain("secure-development,quiz");
    });

    it("refuses an unknown module id rather than storing it", async () => {
      await expect(
        updateAdminSettings({ enabledModules: ["secure-development", "not-a-module"] as never }, "alice"),
      ).rejects.toBeInstanceOf(AdminValidationError);
      expect(mocks.upstashEval).not.toHaveBeenCalled();
    });

    it("refuses a non-array", async () => {
      await expect(
        updateAdminSettings({ enabledModules: "quiz" as never }, "alice"),
      ).rejects.toBeInstanceOf(AdminValidationError);
    });

    it("dedupes before storing", async () => {
      process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";
      mocks.upstashEval.mockResolvedValue([]);
      await updateAdminSettings({ enabledModules: ["secure-development", "quiz", "quiz"] }, "alice");
      expect(mocks.upstashEval.mock.calls[0][2]).toContain("secure-development,quiz");
    });

    it("never deletes a module's data — the patch writes one field", async () => {
      // The toggle is a switch, not a delete: re-enabling must restore the
      // same board. Nothing in this path may touch ctf:quiz:* or ctf:classic:*.
      process.env.SCORE_IMAGE = "ghcr.io/x/score:latest";
      mocks.upstashEval.mockResolvedValue([]);
      await updateAdminSettings({ enabledModules: ["secure-development"] }, "alice");
      const [script, keys] = mocks.upstashEval.mock.calls[0];
      expect(keys.every((k) => k.startsWith("ctf:admin:"))).toBe(true);
      expect(script).not.toMatch(/quiz|classic/i);
    });
  });

  it("rejects an unknown patch key", async () => {
    await expect(updateAdminSettings({ bogus: true } as never, "alice")).rejects.toBeInstanceOf(AdminValidationError);
  });

  it("rejects an empty patch", async () => {
    await expect(updateAdminSettings({}, "alice")).rejects.toBeInstanceOf(AdminValidationError);
  });
});

describe("updateAdminSettings write", () => {
  it("passes only the changed fields, the actor, and a timestamp into one eval", async () => {
    mocks.upstashEval.mockResolvedValue(["paused", "1", "updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z"]);
    const out = await updateAdminSettings({ paused: true }, "alice");
    expect(mocks.upstashEval).toHaveBeenCalledOnce();
    const [, keys, args] = mocks.upstashEval.mock.calls[0];
    expect(keys).toEqual(["ctf:admin:settings", "ctf:admin:audit"]);
    // args carry the actor, the cap, an audit JSON line, and the paused field
    expect(args).toContain("alice");
    expect(args.some((a) => String(a).includes('"paused":true'))).toBe(true);
    expect(out.paused).toBe(true);
  });

  it("clears paused via HDEL instead of writing the string \"0\" when unpausing", async () => {
    // paused is a two-state field (\"1\" or absent) — false must mean absent,
    // not the string "0", so the sync poller and scorer's presence checks
    // don't misread an un-pause as still-paused.
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z"]);
    const out = await updateAdminSettings({ paused: false }, "alice");
    expect(mocks.upstashEval).toHaveBeenCalledOnce();
    const [script, , args] = mocks.upstashEval.mock.calls[0];

    // updatedBy/updatedAt and the audit line are still written — unpausing is
    // a real audited change.
    expect(args).toContain("alice");
    expect(args.some((a) => String(a).includes('"paused":false'))).toBe(true);

    // "paused" must appear only as a field slated for deletion, never as an
    // HSET pair with value "0" or "1".
    const strArgs = args.map(String);
    const pausedIdx = strArgs.indexOf("paused");
    expect(pausedIdx).toBeGreaterThan(-1);
    expect(strArgs[pausedIdx + 1]).not.toBe("0");
    expect(strArgs[pausedIdx + 1]).not.toBe("1");

    // The script itself must HDEL, not just HSET, the settings hash.
    expect(String(script)).toContain("HDEL");

    expect(out.paused).toBe(false);
  });

  it("closing teamRegistrationOpen writes \"0\" (HSET), never HDEL", async () => {
    mocks.upstashEval.mockResolvedValue([
      "teamRegistrationOpen", "0", "updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z",
    ]);
    const out = await updateAdminSettings({ teamRegistrationOpen: false }, "alice");
    const [, , args] = mocks.upstashEval.mock.calls[0];
    const strArgs = args.map(String);
    const idx = strArgs.indexOf("teamRegistrationOpen");
    expect(idx).toBeGreaterThan(-1);
    expect(strArgs[idx + 1]).toBe("0"); // written as an HSET pair, value "0"
    // numDels (args[4]) is 0 — nothing is HDEL'd when closing.
    expect(strArgs[4]).toBe("0");
    expect(out.teamRegistrationOpen).toBe(false);
  });

  it("opening teamRegistrationOpen HDELs the field instead of writing \"1\"", async () => {
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z"]);
    const out = await updateAdminSettings({ teamRegistrationOpen: true }, "alice");
    const [, , args] = mocks.upstashEval.mock.calls[0];
    const strArgs = args.map(String);
    // numDels is 1 and the sole del target is teamRegistrationOpen.
    expect(strArgs[4]).toBe("1");
    expect(strArgs[5]).toBe("teamRegistrationOpen");
    // It never appears as an HSET pair with "1"/"0".
    const idx = strArgs.indexOf("teamRegistrationOpen");
    expect(strArgs[idx + 1]).not.toBe("1");
    expect(strArgs[idx + 1]).not.toBe("0");
    expect(out.teamRegistrationOpen).toBe(true);
  });

  it("rejects a non-boolean teamRegistrationOpen", async () => {
    await expect(
      updateAdminSettings({ teamRegistrationOpen: "nope" as never }, "alice"),
    ).rejects.toBeInstanceOf(AdminValidationError);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });
});

describe("classicCooldownSec", () => {
  it("stores a valid classic cooldown and rejects an out-of-range one", async () => {
    mocks.upstashEval.mockResolvedValue([
      "classicCooldownSec", "15", "updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z",
    ]);
    await updateAdminSettings({ classicCooldownSec: 15 }, "alice");
    const [, , args] = mocks.upstashEval.mock.calls[0];
    const strArgs = args.map(String);
    // Positional ARGV layout: the field name must be immediately followed by
    // its value in the HSET half of argv, not merely present somewhere (which
    // would also be true if it landed in the HDEL half).
    const idx = strArgs.indexOf("classicCooldownSec");
    expect(idx).toBeGreaterThan(-1);
    expect(strArgs[idx + 1]).toBe("15");

    await expect(updateAdminSettings({ classicCooldownSec: 4000 }, "alice")).rejects.toThrow(
      /classicCooldownSec must be an integer in \[0, 3600\]/,
    );
    await expect(updateAdminSettings({ classicCooldownSec: 1.5 }, "alice")).rejects.toThrow(
      AdminValidationError,
    );
    await expect(updateAdminSettings({ classicCooldownSec: "nope" as never }, "alice")).rejects.toThrow(
      AdminValidationError,
    );
  });
});

// Mirrors classicCooldownSec's own describe block exactly, field-swapped —
// same [0, 3600] bound (AI_COOLDOWN_SEC_MAX), same decode/validate shape.
describe("aiCooldownSec", () => {
  it("decodes an absent field as null and a stored one as a number", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }]);
    expect((await getAdminSettings()).aiCooldownSec).toBeNull();

    mocks.upstashPipeline.mockResolvedValue([{ result: ["aiCooldownSec", "7"] }]);
    expect((await getAdminSettings()).aiCooldownSec).toBe(7);
  });

  it("stores a valid ai cooldown and rejects an out-of-range or non-integer one", async () => {
    mocks.upstashEval.mockResolvedValue([
      "aiCooldownSec", "12", "updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z",
    ]);
    await updateAdminSettings({ aiCooldownSec: 12 }, "alice");
    const [, , args] = mocks.upstashEval.mock.calls[0];
    const strArgs = args.map(String);
    // Positional ARGV layout: the field name must be immediately followed by
    // its value in the HSET half of argv, not merely present somewhere (which
    // would also be true if it landed in the HDEL half).
    const idx = strArgs.indexOf("aiCooldownSec");
    expect(idx).toBeGreaterThan(-1);
    expect(strArgs[idx + 1]).toBe("12");

    await expect(updateAdminSettings({ aiCooldownSec: -1 }, "alice")).rejects.toThrow(
      /aiCooldownSec must be an integer in \[0, 3600\]/,
    );
    await expect(updateAdminSettings({ aiCooldownSec: 3601 }, "alice")).rejects.toThrow(
      /aiCooldownSec must be an integer in \[0, 3600\]/,
    );
    await expect(updateAdminSettings({ aiCooldownSec: 1.5 }, "alice")).rejects.toThrow(
      AdminValidationError,
    );
    await expect(updateAdminSettings({ aiCooldownSec: "x" as never }, "alice")).rejects.toThrow(
      AdminValidationError,
    );
    // No patch-level null-clear exists for this knob — same as classic's:
    // the only route back to "no override" is never writing the field at
    // all (decode reads absent as null). A `null` value is therefore just
    // another non-number, rejected the same way "x" is.
    await expect(updateAdminSettings({ aiCooldownSec: null as never }, "alice")).rejects.toThrow(
      AdminValidationError,
    );
    // Every rejection above refused BEFORE the store: the only Lua call in
    // this whole test is the one valid write at the top. A rejection that
    // still reached upstashEval would validate after writing — the exact
    // ordering bug this pin exists to catch.
    expect(mocks.upstashEval).toHaveBeenCalledTimes(1);
  });
});

describe("getSyncStatus", () => {
  it("returns null when the poller has never written", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }]);
    expect(await getSyncStatus()).toBeNull();
  });

  it("decodes a heartbeat", async () => {
    mocks.upstashPipeline.mockResolvedValue([{
      result: [
        "lastPollAt", "2026-08-14T00:00:00Z", "ingested", "12", "dropped", "2",
        "lastDrop", "submit DVWA#7: rejected (4xx), dropped", "reposPolled", "3", "paused", "0",
      ],
    }]);
    expect(await getSyncStatus()).toEqual({
      lastPollAt: "2026-08-14T00:00:00Z", lastError: null, ingested: 12, dropped: 2,
      lastDrop: "submit DVWA#7: rejected (4xx), dropped", reposPolled: 3, paused: false,
    });
  });

  // The hash a PRE-upgrade poller left behind, read by a post-upgrade app —
  // the state of every already-running event the moment this ships. The drop
  // fields are simply absent, and absent must decode as "none", not NaN.
  it("decodes a heartbeat written before the drop counters existed", async () => {
    mocks.upstashPipeline.mockResolvedValue([{
      result: ["lastPollAt", "2026-08-14T00:00:00Z", "ingested", "12", "reposPolled", "3", "paused", "0"],
    }]);
    expect(await getSyncStatus()).toEqual({
      lastPollAt: "2026-08-14T00:00:00Z", lastError: null, ingested: 12,
      dropped: 0, lastDrop: null, reposPolled: 3, paused: false,
    });
  });
});

describe("scheduled windows", () => {
  const base: AdminSettings = {
    paused: false, hintsEnabled: null, hintCost: null, teamRegistrationOpen: true,
    hintsMinSolves: null, hintsUnlockAfterMin: null,
    quizMaxAttempts: null, quizRetryAfterMin: null, classicCooldownSec: null, aiCooldownSec: null, teamMaxMembers: null, scoreCooldownMin: null,
    scoringStartsAt: null, scoringEndsAt: null, registrationStartsAt: null, registrationEndsAt: null,
    updatedBy: null, updatedAt: null, moduleOverrides: {}, enabledModuleIds: null,
    eventIdentity: {}, secureDevTargets: null, sponsorLogoSize: null,
  };
  const T = (iso: string) => Date.parse(iso);

  it("outsideWindow: before start, after end, inside, unbounded", () => {
    const s = "2026-01-01T00:00:00Z", e = "2026-01-02T00:00:00Z";
    expect(outsideWindow(T("2025-12-31T23:59:00Z"), s, e)).toBe(true);  // before start
    expect(outsideWindow(T("2026-01-02T00:01:00Z"), s, e)).toBe(true);  // after end
    expect(outsideWindow(T("2026-01-01T12:00:00Z"), s, e)).toBe(false); // inside
    expect(outsideWindow(T("2026-01-01T12:00:00Z"), null, null)).toBe(false); // no bounds
    expect(outsideWindow(T("2026-01-01T12:00:00Z"), "not-a-date", "also-bad")).toBe(false); // ignored
  });

  it("effectivePaused: manual OR outside the scoring window", () => {
    const now = T("2026-01-01T12:00:00Z");
    expect(effectivePaused({ ...base, paused: true }, now)).toBe(true); // manual wins
    expect(effectivePaused({ ...base, scoringStartsAt: "2026-01-02T00:00:00Z" }, now)).toBe(true); // before start
    expect(effectivePaused({ ...base, scoringEndsAt: "2026-01-01T00:00:00Z" }, now)).toBe(true);   // after end
    expect(effectivePaused({ ...base, scoringStartsAt: "2026-01-01T00:00:00Z", scoringEndsAt: "2026-01-02T00:00:00Z" }, now)).toBe(false); // inside
  });

  it("effectiveRegistrationOpen: manual AND inside the registration window", () => {
    const now = T("2026-01-01T12:00:00Z");
    expect(effectiveRegistrationOpen({ ...base, teamRegistrationOpen: false }, now)).toBe(false); // manual close wins
    expect(effectiveRegistrationOpen({ ...base, registrationEndsAt: "2026-01-01T00:00:00Z" }, now)).toBe(false); // after end
    expect(effectiveRegistrationOpen({ ...base, registrationStartsAt: "2026-01-01T00:00:00Z", registrationEndsAt: "2026-01-02T00:00:00Z" }, now)).toBe(true); // inside
  });

  it("updateAdminSettings: valid ISO is stored normalised (HSET); null clears (HDEL)", async () => {
    mocks.upstashEval.mockResolvedValue(["scoringStartsAt", "2026-01-01T00:00:00.000Z", "updatedBy", "a", "updatedAt", "x"]);
    await updateAdminSettings({ scoringStartsAt: "2026-01-01T00:00:00Z" }, "a");
    let [, , args] = mocks.upstashEval.mock.calls[0];
    let strArgs = args.map(String);
    const idx = strArgs.indexOf("scoringStartsAt");
    expect(idx).toBeGreaterThan(-1);
    expect(strArgs[idx + 1]).toBe("2026-01-01T00:00:00.000Z"); // normalised ISO

    mocks.upstashEval.mockClear();
    mocks.upstashEval.mockResolvedValue(["updatedBy", "a", "updatedAt", "x"]);
    await updateAdminSettings({ scoringEndsAt: null }, "a");
    [, , args] = mocks.upstashEval.mock.calls[0];
    strArgs = args.map(String);
    expect(strArgs[4]).toBe("1"); // numDels = 1
    expect(strArgs.slice(5, 6)).toContain("scoringEndsAt"); // the del target
  });

  it("updateAdminSettings: rejects an unparseable date", async () => {
    await expect(updateAdminSettings({ scoringStartsAt: "not-a-date" }, "a")).rejects.toThrow(AdminValidationError);
  });
});

describe("module identity overrides", () => {
  // This file does not mock @/lib/modules, so decodeSettings/updateAdminSettings
  // see the REAL, static registry (`ALL_MODULE_IDS` via `isModuleId` — see
  // that comment in admin-store.ts): every registered module id is a valid
  // override target regardless of whether it is currently enabled. "forensics"
  // is not in the registry at all, so it is the reject case that keeps the
  // intent (an unknown id) obvious.
  it("decodes moduleTitle/moduleBlurb fields into moduleOverrides", async () => {
    mocks.upstashPipeline.mockResolvedValue([{
      result: [
        "moduleTitle:secure-development", "Round 1",
        "moduleBlurb:secure-development", "Ten questions.",
      ],
    }]);
    const s = await getAdminSettings();
    expect(s.moduleOverrides).toEqual({ "secure-development": { title: "Round 1", blurb: "Ten questions." } });
  });

  it("drops an override for a module id that is not enabled, keeping a valid one alongside it", async () => {
    // Read-side half of the fail-closed contract: a stale/forged field for a
    // module that isn't enabled must never resurface, even sitting right next
    // to a legitimate override for an enabled module.
    mocks.upstashPipeline.mockResolvedValue([{
      result: [
        "moduleTitle:forensics", "Nope",
        "moduleTitle:secure-development", "Round 1",
      ],
    }]);
    const s = await getAdminSettings();
    expect(s.moduleOverrides).toEqual({ "secure-development": { title: "Round 1" } });
  });

  it("defaults moduleOverrides to an empty object", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: [] }]);
    expect((await getAdminSettings()).moduleOverrides).toEqual({});
  });

  it("accepts a title for an enabled module", async () => {
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z"]);
    await updateAdminSettings({ "moduleTitle:secure-development": "Round 1" }, "alice");
    const [, , args] = mocks.upstashEval.mock.calls[0];
    const strArgs = args.map(String);
    const idx = strArgs.indexOf("moduleTitle:secure-development");
    expect(idx).toBeGreaterThan(-1);
    expect(strArgs[idx + 1]).toBe("Round 1"); // written as an HSET pair, not dropped silently
  });

  it("rejects a title for a module that is not enabled", async () => {
    await expect(updateAdminSettings({ "moduleTitle:forensics": "Nope" }, "alice")).rejects.toThrow(
      AdminValidationError,
    );
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });

  it("rejects an over-length title", async () => {
    await expect(
      updateAdminSettings({ "moduleTitle:secure-development": "x".repeat(61) }, "alice"),
    ).rejects.toThrow(AdminValidationError);
  });

  it("rejects an over-length blurb", async () => {
    await expect(
      updateAdminSettings({ "moduleBlurb:secure-development": "x".repeat(201) }, "alice"),
    ).rejects.toThrow(AdminValidationError);
  });

  it("rejects control characters", async () => {
    await expect(
      updateAdminSettings({ "moduleTitle:secure-development": "bad\x07title" }, "alice"),
    ).rejects.toThrow(AdminValidationError);
  });

  it("rejects a Unicode bidi override character", async () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) reorders rendered glyphs rather than
    // injecting anything — it could still visually scramble a heading every
    // contestant loads, so it's rejected alongside C0 control characters.
    await expect(
      updateAdminSettings({ "moduleTitle:secure-development": "bad\u202Etitle" }, "alice"),
    ).rejects.toThrow(AdminValidationError);
  });

  it("rejects a non-string value", async () => {
    await expect(
      updateAdminSettings({ "moduleTitle:secure-development": 7 as never }, "alice"),
    ).rejects.toThrow(AdminValidationError);
  });

  it("clears the field on an empty string (HDEL), not by storing it (HSET)", async () => {
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-08-14T00:00:00Z"]);
    await updateAdminSettings({ "moduleTitle:secure-development": "" }, "alice");
    // Assert the positional ARGV layout, same as the schedule-field clearing
    // case above: numDels at index 4, then the del target(s) in the slots
    // immediately after. A plain `toContain` on the field name would pass
    // whether it landed in dels or in fields — this pins it to HDEL.
    const [, , args] = mocks.upstashEval.mock.calls[0];
    const strArgs = args.map(String);
    expect(strArgs[4]).toBe("1"); // numDels = 1
    expect(strArgs.slice(5, 6)).toContain("moduleTitle:secure-development"); // the del target
  });
});

describe("event identity fields (issue #386)", () => {
  it("decodes only the stored identity fields, applying no defaults", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: ["eventName", "Demo CTF", "eventDiscord", "https://discord.gg/x"] }]);
    const s = await getAdminSettings();
    expect(s.eventIdentity).toEqual({ eventName: "Demo CTF", eventDiscord: "https://discord.gg/x" });
  });
  it("decodes an empty hash to no identity overrides", async () => {
    mocks.upstashPipeline.mockResolvedValueOnce([{ result: [] }]);
    expect((await getAdminSettings()).eventIdentity).toEqual({});
  });
  it("writes a trimmed name as an HSET pair", async () => {
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-09-10T00:00:00Z"]);
    await updateAdminSettings({ eventName: "  Demo CTF " }, "alice");
    const strArgs = mocks.upstashEval.mock.calls[0][2].map(String);
    const idx = strArgs.indexOf("eventName");
    expect(idx).toBeGreaterThan(-1);
    expect(strArgs[idx + 1]).toBe("Demo CTF");
  });
  it("clears a field on an empty string (HDEL), never storing it", async () => {
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-09-10T00:00:00Z"]);
    await updateAdminSettings({ eventTheme: "   " }, "alice");
    const strArgs = mocks.upstashEval.mock.calls[0][2].map(String);
    expect(strArgs[4]).toBe("1"); // numDels
    expect(strArgs[5]).toBe("eventTheme");
    expect(strArgs.slice(6)).not.toContain("eventTheme");
  });
  it.each([
    ["eventName", "x".repeat(81)],
    ["eventName", "Demo‮CTF"],
    ["eventContact", "not-an-email"],
    ["eventDiscord", "http://discord.gg/x"],
    ["eventDiscord", "discord.gg/x"],
    ["eventTheme", 7],
  ] as const)("rejects an invalid %s (%s) before any write", async (key, value) => {
    await expect(updateAdminSettings({ [key]: value } as never, "alice")).rejects.toThrow(AdminValidationError);
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });
  it("accepts an e-mail and an https URL", async () => {
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-09-10T00:00:00Z"]);
    await updateAdminSettings({ eventContact: "org@example.org", eventDiscord: "https://discord.gg/x" }, "alice");
    const strArgs = mocks.upstashEval.mock.calls[0][2].map(String);
    expect(strArgs).toContain("org@example.org");
    expect(strArgs).toContain("https://discord.gg/x");
  });

  // CodeRabbit round 2: eventDiscord can carry an invite/join token, and the
  // audit line used to serialise the raw value into an admin-visible log.
  // The stored HSET pair still needs the real value (asserted above) — only
  // the audit JSON must be redacted.
  it("never puts the eventDiscord value (or its token) into the audit record, and marks it set", async () => {
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-09-10T00:00:00Z"]);
    await updateAdminSettings({ eventDiscord: "https://discord.gg/SECRETTOKEN" }, "alice");
    const args = mocks.upstashEval.mock.calls[0][2];
    // ARGV[3] is the audit JSON line (see UPDATE_SCRIPT's own ARGV layout
    // comment): [1]=updatedBy [2]=updatedAt [3]=auditLine ...
    const auditLine = String(args[2]);
    expect(auditLine).not.toContain("SECRETTOKEN");
    expect(auditLine).not.toContain("https://discord.gg/SECRETTOKEN");
    const audit = JSON.parse(auditLine);
    expect(audit.changed).toEqual({ eventDiscord: "set" });
    // The value itself is still written to the hash — only the audit is redacted.
    const strArgs = args.map(String);
    expect(strArgs).toContain("https://discord.gg/SECRETTOKEN");
  });

  it("marks a cleared identity field as \"cleared\" in the audit record, for all five keys", async () => {
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-09-10T00:00:00Z"]);
    await updateAdminSettings(
      { eventName: "", eventTheme: "", eventLocation: "", eventContact: "", eventDiscord: "" },
      "alice",
    );
    const auditLine = String(mocks.upstashEval.mock.calls[0][2][2]);
    const audit = JSON.parse(auditLine);
    expect(audit.changed).toEqual({
      eventName: "cleared",
      eventTheme: "cleared",
      eventLocation: "cleared",
      eventContact: "cleared",
      eventDiscord: "cleared",
    });
  });
});

describe("secureDevTargets (issue #386, PR 2)", () => {
  it("writes a deduplicated, catalogue-ordered JSON array as an HSET pair", async () => {
    mocks.upstashEval.mockResolvedValue(["updatedBy", "alice", "updatedAt", "2026-09-11T00:00:00Z"]);
    await updateAdminSettings({ secureDevTargets: ["vampi", "dvwa", "dvwa"] }, "alice");
    const strArgs = mocks.upstashEval.mock.calls[0][2].map(String);
    const idx = strArgs.indexOf("secureDevTargets");
    expect(idx).toBeGreaterThan(-1);
    expect(strArgs[idx + 1]).toBe('["dvwa","vampi"]');
  });

  it.each([[[]], [["nope"]], ["dvwa"]] as const)(
    "rejects %j with the shared message and never reaches upstashEval",
    async (value) => {
      await expect(updateAdminSettings({ secureDevTargets: value as never }, "alice")).rejects.toMatchObject({
        message: SECURE_DEV_TARGETS_MESSAGE,
      });
      expect(mocks.upstashEval).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-array, non-string value the same way", async () => {
    await expect(updateAdminSettings({ secureDevTargets: 7 as never }, "alice")).rejects.toBeInstanceOf(
      AdminValidationError,
    );
    expect(mocks.upstashEval).not.toHaveBeenCalled();
  });
});

// --- teamMaxMembers validation (issue #99) ---------------------------------

describe("teamMaxMembers", () => {
  it("rejects 0, which would make every join fail", async () => {
    // Not a pedantic bound. A stored 0 refuses every join including the
    // captain's own team, while the panel cheerfully advertises "0 players
    // max" — an event nobody can form a team in, from one typo.
    await expect(updateAdminSettings({ teamMaxMembers: 0 }, "alice")).rejects.toBeInstanceOf(AdminValidationError);
  });

  it.each([[-1], [1.5], [TEAM_MAX_MEMBERS_MAX + 1]])("rejects %p", async (v) => {
    await expect(updateAdminSettings({ teamMaxMembers: v }, "alice")).rejects.toBeInstanceOf(AdminValidationError);
  });

  it("accepts the bounds themselves", async () => {
    await expect(updateAdminSettings({ teamMaxMembers: 1 }, "alice")).resolves.toBeDefined();
    await expect(updateAdminSettings({ teamMaxMembers: TEAM_MAX_MEMBERS_MAX }, "alice")).resolves.toBeDefined();
  });

  it("decodes a stored value as a number, not the string Redis returns", async () => {
    // The absent case (null ⇒ use the default) is covered by the empty-hash
    // test above. This is the other half: a stored "6" must reach the resolver
    // as 6, or the Lua script gets a string and tonumber() silently decides
    // the cap.
    mocks.upstashPipeline.mockResolvedValue([{ result: ["teamMaxMembers", "6"] }]);
    expect((await getAdminSettings()).teamMaxMembers).toBe(6);
  });
});

// --- sponsorLogoSize validation ---------------------------------------------

describe("sponsorLogoSize", () => {
  it("accepts each known size", async () => {
    for (const v of ["sm", "md", "lg"] as const) {
      await expect(updateAdminSettings({ sponsorLogoSize: v }, "alice")).resolves.toBeDefined();
    }
  });

  it("rejects an unknown size", async () => {
    // @ts-expect-error deliberately invalid at the runtime boundary
    await expect(updateAdminSettings({ sponsorLogoSize: "xl" }, "alice")).rejects.toBeInstanceOf(
      AdminValidationError,
    );
  });

  it("null and empty string both clear back to the default", async () => {
    await expect(updateAdminSettings({ sponsorLogoSize: null }, "alice")).resolves.toBeDefined();
    await expect(updateAdminSettings({ sponsorLogoSize: "" }, "alice")).resolves.toBeDefined();
  });

  it("decodes a stored value, and ignores a stale/unknown one as absent", async () => {
    mocks.upstashPipeline.mockResolvedValue([{ result: ["sponsorLogoSize", "lg"] }]);
    expect((await getAdminSettings()).sponsorLogoSize).toBe("lg");

    mocks.upstashPipeline.mockResolvedValue([{ result: ["sponsorLogoSize", "xl"] }]);
    expect((await getAdminSettings()).sponsorLogoSize).toBeNull();
  });
});
