// Announce store (#590): config validation + writes, ledger claims, the CAS
// result mapping, the outbox and the status counters. The Lua script itself
// is pinned against a real Redis in announce.upstash.test.ts; here the pipeline
// is mocked and the POINT is what the store does with each reply — including
// the two failure directions that matter: a claim failure must not post, and
// a config read failure must THROW (never read as "all off").

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstashEval: vi.fn<(script: string, keys: string[], args: (string | number)[]) => Promise<unknown>>(),
  upstashPipeline: vi.fn<(commands: (string | number)[][]) => Promise<{ result?: unknown; error?: string }[]>>(),
  writeAdminAudit: vi.fn<(actor: string, action: string, detail: Record<string, unknown>) => Promise<void>>(),
  getAdminSettings: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashPipeline: mocks.upstashPipeline, upstashEval: mocks.upstashEval }));
vi.mock("@/lib/admin-store", () => ({
  writeAdminAudit: mocks.writeAdminAudit,
  getAdminSettings: mocks.getAdminSettings,
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
  OUTBOX_CLAIM_SCRIPT,
  OUTBOX_COMPLETE_SCRIPT,
  OUTBOX_SKIP_SCRIPT,
  outboxClaim,
  outboxComplete,
  outboxEnqueue,
  outboxPending,
  outboxPrune,
  outboxRetryable,
  outboxSkip,
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
  mocks.getAdminSettings.mockReset();
  // Default: every command succeeds with an empty result.
  mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: [] as unknown[] })));
  // The pre-launch baseline used by the webhook-set reconciliation.
  mocks.getAdminSettings.mockResolvedValue({ scoringStartsAt: null, scoringEndsAt: null, paused: false });
  mocks.upstashEval.mockResolvedValue([2, 1, ""]);
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

  it("THROWS when the transport fails — a failed read is not an all-off box", async () => {
    mocks.upstashPipeline.mockRejectedValue(new Error("boom"));
    await expect(getAnnounceConfig()).rejects.toThrow("boom");
  });

  it("THROWS on a per-command read error, never reading it as all-off", async () => {
    // upstashPipeline reports per-command failures positionally as
    // `{ error }` without throwing (AGENTS.md); a NOAUTH or WRONGTYPE here
    // must surface as a failure, not silently disable a configured
    // announcer.
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => (cmd[0] === "HGETALL" ? { error: "NOAUTH Client sent AUTH, but no password is set" } : { result: null })),
    );
    await expect(getAnnounceConfig()).rejects.toThrow(/config read failed/);
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => (cmd[0] === "GET" ? { error: "WRONGTYPE Operation against a key holding the wrong kind of value" } : { result: [] })),
    );
    await expect(getAnnounceConfig()).rejects.toThrow(/config read failed/);
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

  it("cancels retained entries for every stream a patch turns off, before the config write", async () => {
    const at = new Date().toISOString();
    const entry = (kind: string, status: string, n = 0) => JSON.stringify({ kind, payload: {}, at, n, status });
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => {
        if (cmd[0] === "HGETALL" && cmd[1] === ANNOUNCE_OUTBOX_KEY) {
          return {
            result: [
              "p1", entry("pause", "pending"),
              "r1", entry("milestone", "failed", 1),
              "old", entry("milestone", "failed", 5),
              "done", entry("pause", "sent"),
              "keep", entry("first-blood", "pending"),
            ],
          };
        }
        return { result: [] };
      }),
    );
    await updateAnnounceConfig("admin", { pause: false, milestones: false });
    const commands = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]);
    const skipped = commands
      .filter((cmd) => cmd[0] === "EVAL" && cmd[1] === OUTBOX_SKIP_SCRIPT)
      .map((cmd) => cmd[5]);
    expect(skipped.sort()).toEqual(["p1", "r1"]);
    const firstSkip = commands.findIndex((cmd) => cmd[0] === "EVAL" && cmd[1] === OUTBOX_SKIP_SCRIPT);
    const configWrite = commands.findIndex((cmd) => cmd[0] === "HSET" && cmd.includes(DISCORD_CONFIG_KEY));
    expect(firstSkip).toBeGreaterThan(-1);
    expect(firstSkip).toBeLessThan(configWrite);
  });

  it("a failed cancellation leaves the switch ON rather than stranding entries", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => (cmd[0] === "HGETALL" && cmd[1] === ANNOUNCE_OUTBOX_KEY ? { error: "NOAUTH" } : { result: [] })),
    );
    await expect(updateAnnounceConfig("admin", { launch: false })).rejects.toThrow(/outbox read failed/);
    const commands = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]);
    expect(commands.some((cmd) => cmd[0] === "HSET" && cmd.includes(DISCORD_CONFIG_KEY))).toBe(false);
  });
});

describe("setAnnounceWebhook", () => {
  it("stores a valid URL and audits only 'set' — never the URL", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: "OK" })));
    const result = await setAnnounceWebhook("admin", VALID_URL);
    expect(result).toEqual({ webhookConfigured: true });
    const set = mocks.upstashPipeline.mock.calls
      .flatMap((call) => call[0])
      .find((cmd) => cmd[0] === "SET" && cmd[1] === DISCORD_WEBHOOK_KEY);
    expect(set).toBeDefined();
    expect(mocks.writeAdminAudit).toHaveBeenCalledWith("admin", "announce-webhook", { state: "set" });
    expect(JSON.stringify(mocks.writeAdminAudit.mock.calls)).not.toContain(VALID_URL);
  });

  it("reconciles the stored lifecycle before arming, so a launch/close during a cleared webhook is not replayed", async () => {
    mocks.getAdminSettings.mockResolvedValue({
      scoringStartsAt: "2020-01-01T10:00:00Z",
      scoringEndsAt: "2020-01-01T11:00:00Z",
      paused: false,
    });
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => (cmd[0] === "GET" ? { result: "v2|L0P0C0A0" } : { result: "OK" })),
    );
    mocks.upstashEval.mockResolvedValue([1, 5, "v2|L0P0C0A0"]);
    await setAnnounceWebhook("admin", VALID_URL);
    expect(mocks.upstashEval).toHaveBeenCalledWith(expect.any(String), ["ctf:announce:lifecycle", "ctf:announce:seq"], [
      "v2|L0P0C0A0",
      "v2|L1P0C1A0",
      expect.any(String),
    ]);
  });

  it("preserves an already-announced pause while reconciling, so its resume is still owed", async () => {
    mocks.getAdminSettings.mockResolvedValue({
      scoringStartsAt: "2020-01-01T10:00:00Z",
      scoringEndsAt: "2020-01-01T11:00:00Z",
      paused: false,
    });
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => (cmd[0] === "GET" ? { result: "v2|L1P1C0A1" } : { result: "OK" })),
    );
    mocks.upstashEval.mockResolvedValue([1, 6, "v2|L1P1C0A1"]);
    await setAnnounceWebhook("admin", VALID_URL);
    expect(mocks.upstashEval).toHaveBeenCalledWith(expect.any(String), ["ctf:announce:lifecycle", "ctf:announce:seq"], [
      "v2|L1P1C0A1",
      "v2|L1P0C1A1",
      expect.any(String),
    ]);
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

  it("cancels every retained entry before clearing the webhook", async () => {
    const at = new Date().toISOString();
    const entry = (kind: string, status: string) => JSON.stringify({ kind, payload: {}, at, n: 0, status });
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => {
        if (cmd[0] === "HGETALL" && cmd[1] === ANNOUNCE_OUTBOX_KEY) {
          return { result: ["p1", entry("pause", "pending"), "l1", entry("launch", "failed"), "s1", entry("launch", "sent")] };
        }
        return { result: 1 };
      }),
    );
    await setAnnounceWebhook("admin", null);
    const commands = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]);
    const skipped = commands
      .filter((cmd) => cmd[0] === "EVAL" && cmd[1] === OUTBOX_SKIP_SCRIPT)
      .map((cmd) => cmd[5]);
    expect(skipped.sort()).toEqual(["l1", "p1"]);
    const firstSkip = commands.findIndex((cmd) => cmd[0] === "EVAL" && cmd[1] === OUTBOX_SKIP_SCRIPT);
    const del = commands.findIndex((cmd) => cmd[0] === "DEL" && cmd[1] === DISCORD_WEBHOOK_KEY);
    expect(firstSkip).toBeLessThan(del);
  });

  it("does not clear the webhook when cancelling its retained entries fails", async () => {
    const entry = JSON.stringify({ kind: "launch", payload: {}, at: new Date().toISOString(), n: 0, status: "pending" });
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: ["l1", entry] }])
      .mockResolvedValueOnce([{ error: "OOM" }]);
    await expect(setAnnounceWebhook("admin", null)).rejects.toThrow(/outbox cancel failed/);
    const commands = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]);
    expect(commands.some((cmd) => cmd[0] === "DEL" && cmd[1] === DISCORD_WEBHOOK_KEY)).toBe(false);
  });

  it("refuses to arm the webhook when the lifecycle pack cannot be read", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => (cmd[0] === "GET" && cmd[1] === "ctf:announce:lifecycle" ? { error: "NOAUTH" } : { result: "OK" })),
    );
    await expect(setAnnounceWebhook("admin", VALID_URL)).rejects.toThrow(/state read failed/);
    const commands = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]);
    expect(commands.some((cmd) => cmd[0] === "SET" && cmd[1] === DISCORD_WEBHOOK_KEY)).toBe(false);
  });

  it("refuses to arm the webhook when the lifecycle pack keeps moving", async () => {
    mocks.getAdminSettings.mockResolvedValue({
      scoringStartsAt: "2020-01-01T10:00:00Z",
      scoringEndsAt: "2020-01-01T11:00:00Z",
      paused: false,
    });
    mocks.upstashPipeline.mockImplementation(async (commands) =>
      commands.map((cmd) => (cmd[0] === "GET" ? { result: "v2|L0P0C0A0" } : { result: "OK" })),
    );
    mocks.upstashEval.mockResolvedValue([0, 1, "v2|L0P0C0A0"]);
    await expect(setAnnounceWebhook("admin", VALID_URL)).rejects.toThrow(/did not converge/);
    expect(mocks.upstashEval).toHaveBeenCalledTimes(3);
    const commands = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]);
    expect(commands.some((cmd) => cmd[0] === "SET" && cmd[1] === DISCORD_WEBHOOK_KEY)).toBe(false);
  });
});

describe("getWebhookUrl", () => {
  it("returns the stored URL, and null only when the key is genuinely absent", async () => {
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: VALID_URL })));
    expect(await getWebhookUrl()).toBe(VALID_URL);
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: null })));
    expect(await getWebhookUrl()).toBeNull();
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map(() => ({ result: "" })));
    expect(await getWebhookUrl()).toBeNull();
  });

  it("THROWS on a transport failure — a failed read is not a missing webhook", async () => {
    mocks.upstashPipeline.mockRejectedValue(new Error("down"));
    await expect(getWebhookUrl()).rejects.toThrow("down");
  });

  it("THROWS on a per-command error instead of returning null", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ error: "NOAUTH" }]);
    await expect(getWebhookUrl()).rejects.toThrow(/webhook read failed/);
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockImplementation(async () => [{ error: "NOAUTH" }]);
    expect(await readStatePack("ctf:announce:lifecycle")).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("[announce] state read failed:", expect.any(String));
    errorSpy.mockRestore();
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

  it("claims the lease atomically when status and attempts match, returning its owner token", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: 1 }]);
    const token = await outboxClaim("id-1", { status: "pending", n: 0 });
    expect(typeof token).toBe("string");
    const cmd = mocks.upstashPipeline.mock.calls[0][0][0];
    expect(cmd[0]).toBe("EVAL");
    expect(cmd[1]).toBe(OUTBOX_CLAIM_SCRIPT);
    expect(cmd[2]).toBe(2);
    expect(cmd[3]).toBe(ANNOUNCE_OUTBOX_KEY);
    expect(cmd[4]).toBe("ctf:announce:lease:id-1");
    expect(cmd[5]).toBe("id-1");
    expect(cmd[6]).toBe("pending");
    expect(cmd[7]).toBe(0);
    expect(cmd[8]).toBe(90_000);
    expect(cmd[9]).toBe(token);
  });

  it("reproduces the race: returns no lease when another worker marked the entry sent", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: 0 }]);
    expect(await outboxClaim("id-1", { status: "pending", n: 0 })).toBeNull();
  });

  it("returns no lease and logs when Redis returns a command error", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ error: "ERR timeout" }]);
    expect(await outboxClaim("id-1", { status: "pending", n: 0 })).toBeNull();
  });

  it("completes an entry under its owner token, bumping attempts on failure", async () => {
    const entry = JSON.stringify({ kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "pending" });
    mocks.upstashPipeline.mockImplementation(async (commands) => commands.map((cmd) => (cmd[0] === "HGET" ? { result: entry } : { result: 1 })));
    await outboxComplete("id-1", "failed", "token-1");
    const evalCmd = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]).find((c) => c[0] === "EVAL");
    expect(evalCmd?.[1]).toBe(OUTBOX_COMPLETE_SCRIPT);
    expect(evalCmd?.[2]).toBe(2);
    expect(evalCmd?.[3]).toBe(ANNOUNCE_OUTBOX_KEY);
    expect(evalCmd?.[4]).toBe("ctf:announce:lease:id-1");
    expect(evalCmd?.[5]).toBe("token-1");
    expect(evalCmd?.[6]).toBe("id-1");
    expect(String(evalCmd?.[7])).toContain('"n":1');
  });

  it("leaves status and lease untouched when the caller no longer owns the lease", async () => {
    const entry = JSON.stringify({ kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "pending" });
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: entry }])
      .mockResolvedValueOnce([{ result: 0 }]);
    await outboxComplete("id-1", "sent", "stale-token");
    const commands = mocks.upstashPipeline.mock.calls.flatMap((call) => call[0]);
    expect(commands.some((c) => c[0] === "HSET")).toBe(false);
    expect(commands.some((c) => c[0] === "DEL")).toBe(false);
  });

  it("skips an unclaimed entry with the conditional script", async () => {
    mocks.upstashPipeline.mockImplementation(async () => [{ result: 1 }]);
    await outboxSkip("id-1");
    const cmd = mocks.upstashPipeline.mock.calls[0][0][0];
    expect(cmd[0]).toBe("EVAL");
    expect(cmd[1]).toBe(OUTBOX_SKIP_SCRIPT);
    expect(cmd[2]).toBe(2);
    expect(cmd[3]).toBe(ANNOUNCE_OUTBOX_KEY);
    expect(cmd[4]).toBe("ctf:announce:lease:id-1");
    expect(cmd[5]).toBe("id-1");
  });

  it("logs and returns when outboxComplete encounters a read error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockImplementation(async () => [{ error: "NOAUTH" }]);
    await outboxComplete("id-1", "sent", "token-1");
    expect(errorSpy).toHaveBeenCalledWith("[announce] outbox read failed:", expect.any(String));
    errorSpy.mockRestore();
  });

  it("logs when the outboxComplete write pipeline fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const entry = JSON.stringify({ kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "pending" });
    mocks.upstashPipeline
      .mockResolvedValueOnce([{ result: entry }])
      .mockResolvedValueOnce([{ error: "OOM" }]);
    await outboxComplete("id-1", "sent", "token-1");
    expect(errorSpy).toHaveBeenCalledWith("[announce] outbox complete failed:", expect.any(String));
    errorSpy.mockRestore();
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

  it("handles a per-command error in outboxEntries by logging and returning empty", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.upstashPipeline.mockImplementation(async () => [{ error: "NOAUTH" }]);
    expect(await outboxPending()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith("[announce] outbox read failed:", expect.any(String));
    errorSpy.mockRestore();
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
