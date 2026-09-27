// Integration tests: exercises the REAL Lua script against a live Redis (srh
// in CI, Upstash or srh locally), because that's where the atomic
// settings-write + audit-append is actually enforced (a change can never land
// without its audit record). Gating comes from live-redis.ts: skipped without
// the env, a FAILURE when CTF_LUA_SUITES_REQUIRED is set.
//
// Not key-isolated, on purpose: the settings and audit keys are the fixed
// ones the store reads (ADMIN_SETTINGS_KEY / the audit list), and the cap
// test needs an empty audit list to count from. Every other live suite either
// uses run-unique keys or (hint-store) reads these settings, so the live run
// is serial — `--no-file-parallelism` in ci.yml — rather than concurrent.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshId, liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

describe.skipIf(!liveConfigured)("admin-store against a live SRH proxy", () => {
  let AUDIT_CAP: number;
  let getAdminSettings: (typeof import("@/lib/admin-store"))["getAdminSettings"];
  let updateAdminSettings: (typeof import("@/lib/admin-store"))["updateAdminSettings"];
  let upstashPipeline: (typeof import("@/lib/upstash"))["upstashPipeline"];

  beforeAll(async () => {
    ({ AUDIT_CAP, getAdminSettings, updateAdminSettings } = await import("@/lib/admin-store"));
    ({ upstashPipeline } = await import("@/lib/upstash"));
  });

  beforeEach(async () => {
    await upstashPipeline([["DEL", "ctf:admin:settings"], ["DEL", "ctf:admin:audit"]]);
  });

  afterAll(async () => {
    await upstashPipeline([["DEL", "ctf:admin:settings"], ["DEL", "ctf:admin:audit"]]);
  });

  it("writes settings and an audit line atomically", async () => {
    await updateAdminSettings({ paused: true, hintCost: 25 }, "alice");
    const s = await getAdminSettings();
    expect(s.paused).toBe(true);
    expect(s.hintCost).toBe(25);
    expect(s.updatedBy).toBe("alice");
    const [len] = await upstashPipeline([["LLEN", "ctf:admin:audit"]]);
    expect(Number(len.result)).toBe(1);
  });

  it("caps the audit list at AUDIT_CAP", async () => {
    for (let i = 0; i < AUDIT_CAP + 5; i++) await updateAdminSettings({ paused: i % 2 === 0 }, "bot");
    const [len] = await upstashPipeline([["LLEN", "ctf:admin:audit"]]);
    expect(Number(len.result)).toBe(AUDIT_CAP);
  });

  it("clears the paused field to absent (not \"0\") when unpausing", async () => {
    await updateAdminSettings({ paused: true }, "alice");
    const [setGet] = await upstashPipeline([["HGET", "ctf:admin:settings", "paused"]]);
    expect(setGet.result).toBe("1");

    await updateAdminSettings({ paused: false }, "alice");
    const [clearedExists, clearedUpdatedAt] = await upstashPipeline([
      ["HEXISTS", "ctf:admin:settings", "paused"],
      ["HGET", "ctf:admin:settings", "updatedAt"],
    ]);
    expect(Number(clearedExists.result)).toBe(0);
    expect(typeof clearedUpdatedAt.result).toBe("string");
    expect(clearedUpdatedAt.result).toBeTruthy();

    const settings = await getAdminSettings();
    expect(settings.paused).toBe(false);
  });

  it("round-trips an explicitly empty module set", async () => {
    const s = await updateAdminSettings({ enabledModules: [] }, "alice");
    expect(s.enabledModuleIds).toEqual([]);
    expect((await getAdminSettings()).enabledModuleIds).toEqual([]);
  });

  it("round-trips the event identity fields and clears them on empty (issue #386)", async () => {
    await updateAdminSettings(
      { eventName: "Live CTF", eventTheme: "Ship it", eventContact: "org@example.org", eventDiscord: "https://discord.gg/live" },
      "alice",
    );
    let s = await getAdminSettings();
    expect(s.eventIdentity).toEqual({
      eventName: "Live CTF", eventTheme: "Ship it", eventContact: "org@example.org", eventDiscord: "https://discord.gg/live",
    });
    await updateAdminSettings({ eventTheme: "", eventDiscord: "" }, "alice");
    s = await getAdminSettings();
    expect(s.eventIdentity).toEqual({ eventName: "Live CTF", eventContact: "org@example.org" });
    const [fields] = await upstashPipeline([["HKEYS", "ctf:admin:settings"]]);
    expect(fields.result).not.toContain("eventTheme");
    expect(fields.result).not.toContain("eventDiscord");
  });

  // Issue #386, PR 2: the write path stores a JSON array under
  // `secureDevTargets`; the read path (decodeSettings ->
  // normalizeSecureDevTargets) must decode it back exactly, whole-set
  // replace each time (not merged with what was there before).
  it("round-trips the secureDevTargets set through a real write and read", async () => {
    await updateAdminSettings({ secureDevTargets: ["vampi", "dvwa"] }, "alice");
    let s = await getAdminSettings();
    expect(s.secureDevTargets).toEqual(["dvwa", "vampi"]);

    await updateAdminSettings({ secureDevTargets: ["webgoat"] }, "alice");
    s = await getAdminSettings();
    expect(s.secureDevTargets).toEqual(["webgoat"]);
  });

  // #464: the reset script relocks the event — run for real, on throwaway keys
  // (never the shared settings hash), so nothing else in the suite is touched.
  it("RESET_SCRIPT clears the scoring start (not launched) and freezes, atomically", async () => {
    const { RESET_SCRIPT } = await import("@/lib/admin-store");
    const { upstashEval } = await import("@/lib/upstash");
    const settingsKey = liveKey("admin", freshId("settings"));
    const auditKey = liveKey("admin", freshId("audit"));
    await upstashPipeline([["HSET", settingsKey, "scoringStartsAt", "2000-01-01T00:00:00.000Z", "eventName", "Kept"]]);
    await upstashEval(RESET_SCRIPT, [settingsKey, auditKey], ["alice", "2026-10-01T00:00:00.000Z", "e1", "{}", 9]);
    const [start, paused, name] = await upstashPipeline([
      ["HGET", settingsKey, "scoringStartsAt"],
      ["HGET", settingsKey, "paused"],
      ["HGET", settingsKey, "eventName"],
    ]);
    expect(start.result).toBeNull();
    expect(paused.result).toBe("1");
    expect(name.result).toBe("Kept"); // settings other than the launch survive
    await upstashPipeline([["DEL", settingsKey, auditKey]]);
  });
});
