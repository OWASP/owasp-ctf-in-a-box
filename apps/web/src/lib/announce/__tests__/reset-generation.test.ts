// The master reset and the webhook generation share one race: a producer can
// read generation 0, then write its outbox entry after the reset has wiped
// `ctf:announce:*`. If the counter lived under that prefix it would read 0
// again, the stale entry would match, and the retained webhook would deliver
// it. This is the end-to-end guard: real resetEvent, real store, real sweep.

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

import { resetEvent } from "@/lib/admin-store";
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
  OUTBOX_ENQUEUE_SCRIPT,
  OUTBOX_SKIP_SCRIPT,
  WEBHOOK_TARGET_SCRIPT,
  type OutboxEntry,
} from "@/lib/announce/store";

const URL = "https://discord.com/api/webhooks/1/aaaaaaaaaaaaaaaaaaaaaa";
const fetchMock = vi.fn();

const state = {
  generation: 0,
  outbox: new Map<string, OutboxEntry>(),
  skipped: [] as string[],
};

function pipelineFor(runtime: typeof state) {
  return async (commands: (string | number)[][]) => {
    return commands.map((cmd) => {
      const verb = String(cmd[0]);
      const key = String(cmd[1]);
      if (verb === "INCR" && key === ANNOUNCE_WEBHOOK_GENERATION_KEY) {
        runtime.generation += 1;
        return { result: runtime.generation };
      }
      if (verb === "GET" && key === ANNOUNCE_WEBHOOK_GENERATION_KEY) return { result: String(runtime.generation) };
      if (verb === "GET" && key === DISCORD_WEBHOOK_KEY) return { result: URL };
      if (verb === "HGETALL" && key === DISCORD_CONFIG_KEY) return { result: ["launch", "1"] };
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
      if (verb === "SCAN") return { result: ["0", []] };
      return { result: null };
    });
  };
}

beforeEach(() => {
  state.generation = 0;
  state.outbox.clear();
  state.skipped = [];
  mocks.upstashEval.mockReset();
  mocks.upstashPipeline.mockReset();
  mocks.beginScoreLowering.mockReset();
  mocks.endScoreLowering.mockReset();
  mocks.upstashEval.mockImplementation(async (script, keys, args) => {
    if (script === WEBHOOK_TARGET_SCRIPT) return [URL, String(state.generation)];
    if (script === OUTBOX_ENQUEUE_SCRIPT) {
      expect(keys).toEqual([ANNOUNCE_OUTBOX_KEY, DISCORD_CONFIG_KEY, ANNOUNCE_WEBHOOK_GENERATION_KEY]);
      if (Number(args[2]) !== state.generation) return 0;
      state.outbox.set(String(args[0]), JSON.parse(String(args[1])) as OutboxEntry);
      return 1;
    }
    return 1;
  });
  mocks.upstashPipeline.mockImplementation(pipelineFor(state));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reset and the webhook generation", () => {
  it("keeps the generation outside the wiped announcement prefix", () => {
    expect(ANNOUNCE_WEBHOOK_GENERATION_KEY.startsWith("ctf:announce:")).toBe(false);
  });

  it("rejects an entry enqueued after a reset with the generation read before it", async () => {
    const before = await getAnnounceConfig();
    expect(before.webhookConfigured).toBe(true);
    expect(before.webhookGeneration).toBe(0);

    const callsBeforeReset = mocks.upstashPipeline.mock.calls.length;
    await resetEvent({ id: "admin-id", name: "admin" });
    expect(state.generation).toBe(1);
    const resetCalls = mocks.upstashPipeline.mock.calls.map((call) => call[0][0]).slice(callsBeforeReset);
    expect(resetCalls.slice(0, 1)).toEqual([["INCR", ANNOUNCE_WEBHOOK_GENERATION_KEY]]);
    expect(resetCalls.findIndex((cmd) => cmd[0] === "SCAN")).toBeGreaterThan(0);

    // The producer's outbox write lands after the reset advanced the
    // generation, but it still carries the generation its config read
    // observed — the atomic enqueue check rejects it outright.
    const accepted = await outboxEnqueue("race", "launch", { embeds: [] }, before.webhookGeneration, before.kindEpochs.launch);
    expect(accepted).toBe(false);
    expect(state.outbox.has("race")).toBe(false);

    await flushRetries();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
