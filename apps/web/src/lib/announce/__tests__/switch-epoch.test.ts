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
  ANNOUNCE_OUTBOX_KEY,
  ANNOUNCE_WEBHOOK_GENERATION_KEY,
  DISCORD_CONFIG_KEY,
  DISCORD_WEBHOOK_KEY,
} from "@/lib/announce/keys";
import {
  getAnnounceConfig,
  outboxEnqueue,
  OUTBOX_SKIP_SCRIPT,
  SWITCH_DISABLE_SCRIPT,
  updateAnnounceConfig,
  type OutboxEntry,
} from "@/lib/announce/store";

const URL = "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa";
const fetchMock = vi.fn();

const state = {
  config: new Map<string, string>([["firstBlood", "1"]]),
  outbox: new Map<string, OutboxEntry>(),
  skipped: [] as string[],
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
    if (script === SWITCH_DISABLE_SCRIPT) {
      expect(keys).toEqual([DISCORD_CONFIG_KEY]);
      const n = Number(args[0]);
      for (let i = 0; i < n; i += 1) {
        state.config.set(String(args[1 + i * 2]), String(args[2 + i * 2]));
      }
      for (const field of args.slice(1 + n * 2)) {
        const name = String(field);
        state.config.set(name, String(Number(state.config.get(name) ?? 0) + 1));
      }
      return 1;
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
  it("skips an entry enqueued after a disable's cancellation scan once the switch is re-enabled", async () => {
    const before = await getAnnounceConfig();
    expect(before.firstBlood).toBe(true);
    expect(before.kindEpochs["first-blood"]).toBe(0);

    await updateAnnounceConfig("admin", { firstBlood: false });
    expect(state.config.get("firstBlood")).toBe("0");
    expect(state.config.get("epoch:first-blood")).toBe("1");

    // The producer resumes after the cancellation scan with the epoch it
    // read before the disable.
    await outboxEnqueue("race", "first-blood", { embeds: [] }, before.webhookGeneration, before.kindEpochs["first-blood"]);
    expect(state.outbox.get("race")?.kindEpoch).toBe(0);

    await updateAnnounceConfig("admin", { firstBlood: true });
    const after = await getAnnounceConfig();
    expect(after.firstBlood).toBe(true);
    expect(after.kindEpochs["first-blood"]).toBe(1);

    await flushRetries();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.skipped).toContain("race");
    expect(state.outbox.get("race")?.status).toBe("skipped");
  });
});
