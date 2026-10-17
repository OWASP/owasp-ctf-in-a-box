// Announce store (#590): config validation + writes, ledger claims, the CAS
// result mapping, the outbox and the status counters. The Lua script itself
// is pinned against a real Redis in announce.upstash.test.ts; here the pipeline
// is mocked and the POINT is what the store does with each reply — including
// the two failure directions that matter: a claim failure must not post, and
// a config read failure must fail open to all-off.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(script: string, keys: string[], args: (string | number)[]) => Promise<unknown>>(),
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
  writeAdminAudit: vi.fn<(actor: string, action: string, detail: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline, upstashEval: mocks.upstashEval }));
vi.mock("@/lib/admin-store", () => ({
  writeAdminAudit: mocks.writeAdminAudit,
  adminErrorLabel: (err: unknown) => (err instanceof Error ? err.message : "unknown"),
}));

import {
  AnnounceValidationError,
  bumpStatus,
  claimLedgerField,
  claimLedgerFields,
  getAnnounceConfig,
  getWebhookUrl,
  ledgerFields,
  outboxClaimLease,
  outboxComplete,
  outboxEnqueue,
  outboxPending,
  outboxPrune,
  outboxRetryable,
  publicConfig,
  readStatePack,
  readStatus,
  setAnnounceWebhook,
  stateCompareSet,
  updateAnnounceConfig,
} from "@/lib/announce/store";
import { ANNOUNCE_FIRST_KEY, ANNOUNCE_OUTBOX_KEY, DISCORD_CONFIG_KEY, DISCORD_WEBHOOK_KEY } from "@/lib/announce/keys";

const VALID_URL = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345";

beforeEach(() => {
  mocks.upstashPipeline.mockReset();
  mocks.upstashEval.mockReset();
  mocks.writeAdminAudit.mockReset();
  // Default: every command succeeds with an empty result.
  mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: [] as unknown[] })));
});

describe("getAnnounceConfig", () => {
  it("an absent hash reads as all-off and unconfigured", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: [] as unknown[] })));
    const config = await getAnnounceConfig();
    expect(config.webhookConfigured).toBe(false);
    expect(config.firstBlood).toBe(false);
    expect(config.launch).toBe(false);
    expect(config.marks).toBe("1h, 15m");
  });

  it("decodes stored fields over the defaults, without the URL in the public shape", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => {
        // A stored hash carrying fields outside the current set must be
        // ignored, not surfaced — an old write has no live meaning.
        if (cmd[1] === DISCORD_CONFIG_KEY) return { result: ["firstBlood", "1", "pause", "1", "marks", "5m", "releases", "1", "dailyAt", "09:00"] };
        if (cmd[1] === DISCORD_WEBHOOK_KEY) return { result: VALID_URL };
        return { result: null };
      }),
    );
    const config = await getAnnounceConfig();
    expect(config).toMatchObject({ webhookConfigured: true, firstBlood: true, pause: true, marks: "5m" });
    expect(config).not.toHaveProperty("releases");
    expect(config).not.toHaveProperty("dailyAt");
    const pub = publicConfig(config);
    expect(pub).not.toHaveProperty("webhookUrl");
    expect(JSON.stringify(pub)).not.toContain(VALID_URL);
  });

  it("fails OPEN to all-off when the transport throws", async () => {
    mocks.upstashPipeline.mockRejectedValue(new Error("boom"));
    const config = await getAnnounceConfig();
    expect(config.webhookConfigured).toBe(false);
    expect(config.firstBlood).toBe(false);
  });
});

describe("updateAnnounceConfig", () => {
  it("refuses unknown keys and writes nothing", async () => {
    await expect(updateAnnounceConfig("admin", { bogus: true } as never)).rejects.toBeInstanceOf(AnnounceValidationError);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  // The key is request-controlled text — the refusal message must carry the
  // rule, never the submitted key, or a marker smuggled in one echoes back.
  it("the unknown-key refusal is a FIXED message that never echoes the key", async () => {
    await expect(updateAnnounceConfig("admin", { "FLAG{canary-in-a-key}": true } as never)).rejects.toThrow("unknown announcement setting");
    await expect(updateAnnounceConfig("admin", { "FLAG{canary-in-a-key}": true } as never)).rejects.not.toThrow(/canary/);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("refuses a bad marks value, and any field outside the patch set, writing nothing", async () => {
    await expect(updateAnnounceConfig("admin", { marks: "soon" })).rejects.toBeInstanceOf(AnnounceValidationError);
    for (const patch of [{ releases: true }, { leaderScope: "top3" }, { dailyAt: "09:00" }, { dailyTopN: 10 }] as never[]) {
      await expect(updateAnnounceConfig("admin", patch)).rejects.toBeInstanceOf(AnnounceValidationError);
    }
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("writes validated fields, audits only public values, and returns the public config", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: [] as unknown[] })));
    const config = await updateAnnounceConfig("admin", { firstBlood: true, marks: "15m, 5m" });
    expect(config.firstBlood).toBe(true);
    expect(config.marks).toBe("15m, 5m");
    const hset = mocks.upstashPipeline.mock.calls[0][0][0];
    expect(hset[0]).toBe("HSET");
    expect(hset).toContain(DISCORD_CONFIG_KEY);
    expect(mocks.writeAdminAudit).toHaveBeenCalledWith("admin", "announce-config", { firstBlood: true, marks: "15m, 5m" });
  });
});

describe("setAnnounceWebhook", () => {
  it("stores a valid URL and audits only 'set' — never the URL", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: "OK" })));
    const result = await setAnnounceWebhook("admin", VALID_URL);
    expect(result).toEqual({ webhookConfigured: true });
    const set = mocks.upstashPipeline.mock.calls[0][0][0];
    expect(set[0]).toBe("SET");
    expect(set[1]).toBe(DISCORD_WEBHOOK_KEY);
    expect(mocks.writeAdminAudit).toHaveBeenCalledWith("admin", "announce-webhook", { state: "set" });
    expect(JSON.stringify(mocks.writeAdminAudit.mock.calls)).not.toContain(VALID_URL);
  });

  it("refuses a non-Discord URL with a validation error and writes nothing", async () => {
    await expect(setAnnounceWebhook("admin", "https://evil.example/api/webhooks/1/2")).rejects.toBeInstanceOf(AnnounceValidationError);
    expect(mocks.upstashPipeline).not.toHaveBeenCalled();
  });

  it("clears with DEL and audits only 'cleared'", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: 1 })));
    const result = await setAnnounceWebhook("admin", null);
    expect(result).toEqual({ webhookConfigured: false });
    expect(mocks.writeAdminAudit).toHaveBeenCalledWith("admin", "announce-webhook", { state: "cleared" });
  });
});

describe("getWebhookUrl", () => {
  it("returns the stored URL for the sender's use, and null on failure", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: VALID_URL })));
    expect(await getWebhookUrl()).toBe(VALID_URL);
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: null })));
    expect(await getWebhookUrl()).toBeNull();
    mocks.upstashPipeline.mockRejectedValue(new Error("down"));
    expect(await getWebhookUrl()).toBeNull();
  });
});

describe("ledger claims", () => {
  it("reports the HSETNX winner and treats a command error as NOT won", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: 1 }]);
    expect(await claimLedgerField(ANNOUNCE_FIRST_KEY, "classic:a")).toBe(true);
    mocks.upstashPipeline.mockImplementation(async () => [{ result: 0 }]);
    expect(await claimLedgerField(ANNOUNCE_FIRST_KEY, "classic:a")).toBe(false);
    mocks.upstashPipeline.mockImplementation(async () => [{ error: "NOAUTH" }]);
    expect(await claimLedgerField(ANNOUNCE_FIRST_KEY, "classic:a")).toBe(false);
  });

  it("bulk-claims in one pipeline and returns only the winners", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map((_, i) => ({ result: i === 1 ? 1 : 0 })));
    const won = await claimLedgerFields("led", ["a", "b", "c"]);
    expect([...won]).toEqual(["b"]);
  });

  it("reads HKEYS as a set, failing open to empty", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: ["a", "b"] }]);
    expect([...(await ledgerFields("led"))]).toEqual(["a", "b"]);
    mocks.upstashPipeline.mockRejectedValue(new Error("down"));
    expect((await ledgerFields("led")).size).toBe(0);
  });
});

describe("stateCompareSet / readStatePack", () => {
  it("maps the Lua reply to code/seq/prev", async () => {
    mocks.upstashEval.mockResolvedValue([1, 7, "v1|L0P0"]);
    const cas = await stateCompareSet("ctf:announce:lifecycle", "v1|L0P0", "v1|L1P0");
    expect(cas).toEqual({ code: 1, seq: 7, prev: "v1|L0P0" });
  });

  it("reads the pack, null on miss or error", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: "v1|L1P0" }]);
    expect(await readStatePack("ctf:announce:lifecycle")).toBe("v1|L1P0");
    mocks.upstashPipeline.mockImplementation(async () => [{ result: null }]);
    expect(await readStatePack("ctf:announce:lifecycle")).toBeNull();
  });
});

describe("outbox", () => {
  it("enqueues a pending entry", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: 1 }]);
    await outboxEnqueue("id-1", "first-blood", { embeds: [] });
    const cmd = mocks.upstashPipeline.mock.calls[0][0][0];
    expect(cmd[0]).toBe("HSET");
    expect(cmd[1]).toBe(ANNOUNCE_OUTBOX_KEY);
    expect(String(cmd[3])).toContain('"status":"pending"');
  });

  it("claims the lease only when SET NX PX succeeds", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: "OK" }]);
    expect(await outboxClaimLease("id-1")).toBe(true);
    mocks.upstashPipeline.mockImplementation(async () => [{ result: null }]);
    expect(await outboxClaimLease("id-1")).toBe(false);
  });

  it("completes an entry, bumping attempts on failure and dropping the lease", async () => {
    const entry = JSON.stringify({ kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "pending" });
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map((cmd) => (cmd[0] === "HGET" ? { result: entry } : { result: 1 })));
    await outboxComplete("id-1", "failed");
    // The HGET (to bump attempts) and the HSET+DEL write are two pipelines;
    // the assertion spans both.
    const hset = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]).find((c) => c[0] === "HSET");
    expect(String(hset?.[3])).toContain('"n":1');
  });

  it("lists pending and retryable entries, skipping sent and exhausted", async () => {
    const at = new Date().toISOString();
    const flat = [
      "p1",
      JSON.stringify({ kind: "first-blood", payload: {}, at, n: 0, status: "pending" }),
      "f1",
      JSON.stringify({ kind: "first-blood", payload: {}, at, n: 1, status: "failed" }),
      "f2",
      JSON.stringify({ kind: "first-blood", payload: {}, at, n: 3, status: "failed" }),
      "s1",
      JSON.stringify({ kind: "first-blood", payload: {}, at, n: 0, status: "sent" }),
    ];
    mocks.upstashPipeline.mockImplementation(async () => [{ result: flat }]);
    expect((await outboxPending()).map((x) => x.id)).toEqual(["p1"]);
    expect((await outboxRetryable()).map((x) => x.id)).toEqual(["f1"]);
  });

  it("prunes sent entries past retention and malformed ones", async () => {
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const flat = [
      "old-sent",
      JSON.stringify({ kind: "first-blood", payload: {}, at: old, n: 0, status: "sent" }),
      "fresh-sent",
      JSON.stringify({ kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "sent" }),
      "skipped",
      JSON.stringify({ kind: "first-blood", payload: {}, at: old, n: 0, status: "skipped" }),
      "garbage",
      "not-json",
    ];
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map((cmd) => (cmd[0] === "HGETALL" ? { result: flat } : { result: 1 })));
    await outboxPrune();
    // The prune reads HGETALL first and only then issues the HDELs, in a
    // second pipeline; assert on the one that carries them.
    const prune = mocks.upstashPipeline.mock.calls.map((call) => call[0]).find((cmds) => cmds.some((c) => c[0] === "HDEL")) ?? [];
    expect(prune.filter((c) => c[0] === "HDEL").flatMap((c) => c.slice(2))).toEqual(["old-sent", "skipped", "garbage"]);
  });
});

describe("status", () => {
  it("bumps a sent counter and stamps lastPostedAt; failures record the label", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: 1 }]);
    await bumpStatus("first-blood", "sent");
    const sent = mocks.upstashPipeline.mock.calls[0][0][0];
    expect(sent).toEqual(["HINCRBY", "ctf:announce:status", "first-blood:sent", 1]);
    await bumpStatus("first-blood", "failed", "discord post failed");
    expect(mocks.upstashPipeline.mock.calls[1][0]).toContainEqual(["HSET", "ctf:announce:status", "lastError", "discord post failed"]);
  });

  it("a FAILED outcome bumps no sent counter — the counter is what 'posted' means", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: 1 }]);
    await bumpStatus("first-blood", "failed", "discord post failed");
    expect(mocks.upstashPipeline.mock.calls[0][0]).not.toContainEqual(["HINCRBY", "ctf:announce:status", "first-blood:sent", 1]);
    expect(mocks.upstashPipeline.mock.calls[0][0]).not.toContainEqual(["HSET", "ctf:announce:status", "lastPostedAt", expect.any(String)]);
    // The failure IS recorded, with its stamp.
    expect(mocks.upstashPipeline.mock.calls[0][0]).toContainEqual(["HSET", "ctf:announce:status", "lastError", "discord post failed"]);
    expect(mocks.upstashPipeline.mock.calls[0][0]).toContainEqual(["HSET", "ctf:announce:status", "lastErrorAt", expect.any(String)]);
  });

  it("reads the counters back, failing open to an empty status", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: ["first-blood:sent", "3", "lastPostedAt", "2026-01-01T00:00:00Z"] }]);
    const status = await readStatus();
    expect(status.posted["first-blood"]).toBe(3);
    expect(status.lastPostedAt).toBe("2026-01-01T00:00:00Z");
    mocks.upstashPipeline.mockRejectedValue(new Error("down"));
    expect((await readStatus()).posted).toEqual({});
  });
});
