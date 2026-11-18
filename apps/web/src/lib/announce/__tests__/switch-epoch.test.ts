// A producer can read `firstBlood: true`, lose the CPU, and enqueue after the
// disable's cancellation scan. Turning the switch back on must not deliver
// that entry: the disable advances the kind's epoch, and the producer's entry
// still carries the old one. This is the end-to-end guard for that race —
// real updateAnnounceConfig, real store, real retry sweep.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(s: string, k: string[], a: (string | number)[]) => Promise<unknown>>(),
  upstashPipeline: vi.fn<(c: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
  beginScoreLowering: vi.fn(),
  endScoreLowering: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/leaderboard/fold-cache", () => ({
  beginScoreLowering: mocks.beginScoreLowering,
  endScoreLowering: mocks.endScoreLowering,
}));
vi.mock("@/lib/upstash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upstash")>();
  return {
    assertPipelineOk: actual.assertPipelineOk,
    parseScanPage: actual.parseScanPage,
    upstashEval: mocks.upstashEval,
    upstashPipeline: mocks.upstashPipeline,
  };
});

import { flushRetries } from "@/lib/announce/sender";
import {
  ANNOUNCE_LIFECYCLE_KEY,
  ANNOUNCE_OUTBOX_KEY,
  ANNOUNCE_WEBHOOK_GENERATION_KEY,
  DISCORD_CONFIG_KEY,
  DISCORD_WEBHOOK_KEY,
} from "@/lib/announce/keys";
import {
  CONFIG_PATCH_SCRIPT,
  getAnnounceConfig,
  outboxClaim,
  outboxEnqueue,
  OUTBOX_CLAIM_SCRIPT,
  OUTBOX_ENQUEUE_SCRIPT,
  OUTBOX_SKIP_SCRIPT,
  WEBHOOK_TARGET_SCRIPT,
  updateAnnounceConfig,
  type OutboxEntry,
} from "@/lib/announce/store";

const URL = "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa";
const fetchMock = vi.fn();

const state = {
  config: new Map<string, string>([["firstBlood", "1"]]),
  outbox: new Map<string, OutboxEntry>(),
  skipped: [] as string[],
  baseline: "v1|L0P0" as string | null,
};

function pipelineFor(runtime: typeof state) {
  return async (commands: (string | number)[][]) => {
    return commands.map((cmd) => {
      const verb = String(cmd[0]);
      const key = String(cmd[1]);
      if (verb === "GET" && key === ANNOUNCE_WEBHOOK_GENERATION_KEY) return { result: "0" };
      if (verb === "GET" && key === DISCORD_WEBHOOK_KEY) return { result: URL };
      if (verb === "HGETALL" && key === DISCORD_CONFIG_KEY) {
        return { result: [...runtime.config].flatMap(([field, value]) => [field, value]) };
      }
      if (verb === "HSET" && key === DISCORD_CONFIG_KEY) {
        for (let i = 2; i < cmd.length; i += 2) runtime.config.set(String(cmd[i]), String(cmd[i + 1]));
        return { result: 1 };
      }
      if (verb === "HGETALL" && key === ANNOUNCE_OUTBOX_KEY) {
        return { result: [...runtime.outbox].flatMap(([id, entry]) => [id, JSON.stringify(entry)]) };
      }
      if (verb === "HSET" && key === ANNOUNCE_OUTBOX_KEY) {
        runtime.outbox.set(String(cmd[2]), JSON.parse(String(cmd[3])) as OutboxEntry);
        return { result: 1 };
      }
      if (verb === "EVAL" && cmd[1] === OUTBOX_CLAIM_SCRIPT) {
        const id = String(cmd[7]);
        const seenStatus = String(cmd[8]);
        const seenN = Number(cmd[9]);
        const switchField = String(cmd[12]);
        const epochField = String(cmd[13]);
        const entry = runtime.outbox.get(id);
        if (!entry) return { result: 0 };
        if (entry.status !== seenStatus || entry.n !== seenN) return { result: 0 };
        if (runtime.config.get(switchField) !== "1") return { result: 0 };
        const currentEpoch = Number(runtime.config.get(epochField) ?? 0);
        if (entry.kindEpoch !== currentEpoch) return { result: 0 };
        return { result: 1 };
      }
      if (verb === "EVAL" && cmd[1] === OUTBOX_SKIP_SCRIPT) {
        const id = String(cmd[5]);
        const entry = runtime.outbox.get(id);
        if (entry) {
          entry.status = "skipped";
          runtime.skipped.push(id);
        }
        return { result: 1 };
      }
      return { result: null };
    });
  };
}

beforeEach(() => {
  state.config = new Map([["firstBlood", "1"]]);
  state.outbox.clear();
  state.skipped = [];
  mocks.upstashEval.mockReset();
  mocks.upstashPipeline.mockReset();
  mocks.beginScoreLowering.mockReset();
  mocks.endScoreLowering.mockReset();
  mocks.upstashPipeline.mockImplementation(pipelineFor(state));
  mocks.upstashEval.mockImplementation(async (script, keys, args) => {
    if (script === WEBHOOK_TARGET_SCRIPT) return [URL, "0"];
    if (script === OUTBOX_ENQUEUE_SCRIPT) {
      const [outboxKey, configKey] = keys;
      expect(outboxKey).toBe(ANNOUNCE_OUTBOX_KEY);
      expect(configKey).toBe(DISCORD_CONFIG_KEY);
      const enabled = state.config.get(String(args[4]));
      const currentEpoch = Number(state.config.get(String(args[5])) ?? 0);
      if (enabled !== "1" || Number(args[3]) !== currentEpoch || Number(args[2]) !== 0) return 0;
      state.outbox.set(String(args[0]), JSON.parse(String(args[1])) as OutboxEntry);
      return 1;
    }
    if (script === CONFIG_PATCH_SCRIPT) {
      expect(keys).toEqual([DISCORD_CONFIG_KEY, ANNOUNCE_LIFECYCLE_KEY]);
      const n = Number(args[0]);
      // The script decides off→on against the STORED switches: this mock
      // mirrors that (DEL the baseline on an off→on transition) so a test
      // cannot pass by having the caller wipe the state instead.
      const wasLaunch = state.config.get("launch") === "1";
      const wasPause = state.config.get("pause") === "1";
      let willLaunch = wasLaunch;
      let willPause = wasPause;
      for (let i = 0; i < n; i += 1) {
        const field = String(args[1 + i * 2]);
        const value = String(args[2 + i * 2]);
        if (field === "launch") willLaunch = value === "1";
        if (field === "pause") willPause = value === "1";
      }
      let wiped = 0;
      if (!wasLaunch && !wasPause && (willLaunch || willPause)) {
        state.baseline = null;
        wiped = 1;
      }
      for (let i = 0; i < n; i += 1) {
        state.config.set(String(args[1 + i * 2]), String(args[2 + i * 2]));
      }
      for (const field of args.slice(1 + n * 2)) {
        const name = String(field);
        state.config.set(name, String(Number(state.config.get(name) ?? 0) + 1));
      }
      return wiped;
    }
    return 1;
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("switch epochs", () => {
  it("rejects a stale enqueue after the switch is re-enabled, and accepts one with the current epoch", async () => {
    const before = await getAnnounceConfig();
    expect(before.firstBlood).toBe(true);
    expect(before.kindEpochs["first-blood"]).toBe(0);

    await updateAnnounceConfig({ id: "admin-id", name: "admin" }, { firstBlood: false });
    expect(state.config.get("firstBlood")).toBe("0");
    expect(state.config.get("epoch:first-blood")).toBe("1");

    await updateAnnounceConfig({ id: "admin-id", name: "admin" }, { firstBlood: true });
    const after = await getAnnounceConfig();
    expect(after.firstBlood).toBe(true);
    expect(after.kindEpochs["first-blood"]).toBe(1);

    // A producer that read its config before the disable resumes now: the
    // switch is ON again, so only the epoch check can reject it.
    const staleAccepted = await outboxEnqueue("race", "first-blood", { embeds: [] }, after.webhookGeneration, before.kindEpochs["first-blood"]);
    expect(staleAccepted).toBe(false);
    expect(state.outbox.has("race")).toBe(false);

    await flushRetries();
    expect(fetchMock).not.toHaveBeenCalled();

    // The same enqueue carrying the CURRENT epoch is accepted.
    const freshAccepted = await outboxEnqueue("race-current", "first-blood", { embeds: [] }, after.webhookGeneration, after.kindEpochs["first-blood"]);
    expect(freshAccepted).toBe(true);
    expect(state.outbox.get("race-current")?.kindEpoch).toBe(1);
  });

  it("OUTBOX_CLAIM_SCRIPT refuses lease when switch is disabled or epoch mismatched, and claims when valid", async () => {
    // Seed an entry with epoch 0
    state.outbox.set("entry-1", {
      kind: "first-blood",
      payload: {},
      at: new Date().toISOString(),
      seq: 1,
      n: 0,
      status: "pending",
      webhookGeneration: 0,
      kindEpoch: 0,
    });

    // 1. Valid pending entry with switch=1 and epoch=0 claims successfully
    state.config.set("firstBlood", "1");
    state.config.set("epoch:first-blood", "0");
    const validClaim = await outboxClaim("entry-1", { status: "pending", n: 0, kind: "first-blood" });
    expect(validClaim).not.toBeNull();
    expect(typeof validClaim).toBe("string");

    // 2. Disabled switch: claim returns null (no lease)
    state.config.set("firstBlood", "0");
    const disabledClaim = await outboxClaim("entry-1", { status: "pending", n: 0, kind: "first-blood" });
    expect(disabledClaim).toBeNull();

    // 3. Mismatched epoch: switch is re-enabled but epoch is bumped to 1
    state.config.set("firstBlood", "1");
    state.config.set("epoch:first-blood", "1");
    const staleEpochClaim = await outboxClaim("entry-1", { status: "pending", n: 0, kind: "first-blood" });
    expect(staleEpochClaim).toBeNull();
  });
});
