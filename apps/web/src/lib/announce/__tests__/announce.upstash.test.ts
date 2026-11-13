// Integration tests for the announcer's atomicity primitives (#590), against
// a REAL Redis behind srh: the lifecycle compare-and-swap Lua (exactly one
// replica announces a transition), the HSETNX dedup ledgers (exactly one
// caller wins a first-blood or mark claim), and the outbox lease scripts
// (only the current owner writes a terminal status). These are the only
// places those guarantees are actually enforced — a mocked pipeline can only
// pin what the store SENDS, not what Redis DOES with it.
//
// Every key is run-unique via liveKey(): the CAS script is the store's own
// exported STATE_CAS_SCRIPT (one copy, no drift) run against throwaway
// state/seq keys, and the ledger claims take their ledger key as a
// parameter, so nothing here ever touches the box's real ctf:announce:*
// hashes. Gating is live-redis.ts's: skipped without the env, a FAILURE when
// CTF_LUA_SUITES_REQUIRED is set.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RUN, liveConfigured, liveKey } from "@/lib/__tests__/live-redis";

vi.mock("server-only", () => ({}));

import { upstashEval, upstashPipeline } from "@/lib/upstash";
import {
  OUTBOX_CLAIM_SCRIPT,
  OUTBOX_COMPLETE_SCRIPT,
  OUTBOX_ENQUEUE_SCRIPT,
  OUTBOX_SKIP_SCRIPT,
  SET_ANNOUNCE_COOLDOWN_SCRIPT,
  STATE_CAS_ENQUEUE_SCRIPT,
  STATE_CAS_SCRIPT,
  SWITCH_DISABLE_SCRIPT,
  WEBHOOK_CLEAR_SCRIPT,
  WEBHOOK_TARGET_SCRIPT,
  claimLedgerField,
  claimLedgerFields,
} from "@/lib/announce/store";

const STATE_KEY = liveKey("announce-cas", "state");
const SEQ_KEY = liveKey("announce-cas", "seq");
const LEDGER_KEY = liveKey("announce-cas", "ledger");
const LEASE_ID = `${RUN}-lease`;
const LEASE_KEY = `ctf:announce:lease:${LEASE_ID}`;
const CLAIM_ID = `${RUN}-claim`;
const CLAIM_LEASE_KEY = `ctf:announce:lease:${CLAIM_ID}`;
const CLAIM_GEN_KEY = liveKey("announce-claim", "generation");
const CLAIM_GEN = "7";
const OUTBOX_KEY = liveKey("announce-outbox", "box");
const SWITCH_KEY = liveKey("announce-switch", "config");
const TARGET_URL_KEY = liveKey("announce-target", "url");
const TARGET_GEN_KEY = liveKey("announce-target", "generation");

describe.skipIf(!liveConfigured)("announce CAS + claims (live Redis)", () => {
  beforeAll(async () => {
    await upstashPipeline([["DEL", STATE_KEY, SEQ_KEY, LEDGER_KEY, LEASE_KEY, CLAIM_LEASE_KEY, CLAIM_GEN_KEY, OUTBOX_KEY, SWITCH_KEY, TARGET_URL_KEY, TARGET_GEN_KEY]]);
  });

  afterAll(async () => {
    await upstashPipeline([["DEL", STATE_KEY, SEQ_KEY, LEDGER_KEY, LEASE_KEY, CLAIM_LEASE_KEY, CLAIM_GEN_KEY, OUTBOX_KEY, SWITCH_KEY, TARGET_URL_KEY, TARGET_GEN_KEY]]);
  });

  it("first observation with expected='' seeds silently (code 2) and bumps the seq", async () => {
    const res = (await upstashEval(STATE_CAS_SCRIPT, [STATE_KEY, SEQ_KEY], ["", "v1|L1P0"])) as [number, number, string];
    expect(res[0]).toBe(2);
    expect(res[1]).toBe(1);
    const [get] = await upstashPipeline([["GET", STATE_KEY]]);
    expect(get.result).toBe("v1|L1P0");
  });

  it("the matching expected pack wins the swap (code 1); a stale expected does not (code 0)", async () => {
    // Same expected as the CURRENT value: this replica owns the edge.
    const win = (await upstashEval(STATE_CAS_SCRIPT, [STATE_KEY, SEQ_KEY], ["v1|L1P0", "v1|L1P1"])) as [number, number, string];
    expect(win[0]).toBe(1);
    expect(win[1]).toBe(2);
    expect(win[2]).toBe("v1|L1P0");
    // A second replica still holding the OLD pack loses.
    const lose = (await upstashEval(STATE_CAS_SCRIPT, [STATE_KEY, SEQ_KEY], ["v1|L1P0", "v1|L0P0"])) as [number, number, string];
    expect(lose[0]).toBe(0);
    // A replica that already matches the current value gets 0, not a re-announce.
    const same = (await upstashEval(STATE_CAS_SCRIPT, [STATE_KEY, SEQ_KEY], ["v1|L1P1", "v1|L1P1"])) as [number, number, string];
    expect(same[0]).toBe(0);
  });

  it("HSETNX claims are won exactly once across concurrent callers", async () => {
    const results = await Promise.all([
      claimLedgerField(LEDGER_KEY, "classic:web-1"),
      claimLedgerField(LEDGER_KEY, "classic:web-1"),
      claimLedgerField(LEDGER_KEY, "classic:web-1"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const bulk = await claimLedgerFields(LEDGER_KEY, ["classic:web-1", "classic:web-2"]);
    expect([...bulk]).toEqual(["classic:web-2"]);
  });

  it("the delivery lease is held by exactly one claimer", async () => {
    const [a, b] = await Promise.all([
      upstashPipeline([["SET", LEASE_KEY, "1", "PX", 90_000, "NX"]]),
      upstashPipeline([["SET", LEASE_KEY, "1", "PX", 90_000, "NX"]]),
    ]);
    const winners = [a[0].result, b[0].result].filter((r) => r === "OK");
    expect(winners).toHaveLength(1);
    await upstashPipeline([["DEL", LEASE_KEY]]);
  });

  it("OUTBOX_CLAIM_SCRIPT claims an unchanged entry with an owner token, but rejects once marked sent", async () => {
    const entry = { kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "pending", webhookGeneration: Number(CLAIM_GEN), kindEpoch: 2 };
    const token = `${RUN}-owner-a`;

    await upstashPipeline([
      ["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY, SWITCH_KEY],
      ["SET", CLAIM_GEN_KEY, CLAIM_GEN],
      ["HSET", OUTBOX_KEY, CLAIM_ID, JSON.stringify(entry)],
      ["HSET", SWITCH_KEY, "firstBlood", "1", "epoch:first-blood", "2"],
    ]);

    const win = await upstashEval(OUTBOX_CLAIM_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY, SWITCH_KEY, CLAIM_GEN_KEY], [CLAIM_ID, "pending", 0, 90_000, token, "firstBlood", "epoch:first-blood"]);
    expect(win).toBe(1);
    const [lease] = await upstashPipeline([["GET", CLAIM_LEASE_KEY]]);
    expect(lease.result).toBe(token);

    const held = await upstashEval(OUTBOX_CLAIM_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY, SWITCH_KEY, CLAIM_GEN_KEY], [CLAIM_ID, "pending", 0, 90_000, `${RUN}-owner-b`, "firstBlood", "epoch:first-blood"]);
    expect(held).toBe(0);

    const completed = { ...entry, status: "sent" };
    await upstashPipeline([
      ["HSET", OUTBOX_KEY, CLAIM_ID, JSON.stringify(completed)],
      ["DEL", CLAIM_LEASE_KEY],
    ]);

    const stale = await upstashEval(OUTBOX_CLAIM_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY, SWITCH_KEY, CLAIM_GEN_KEY], [CLAIM_ID, "pending", 0, 90_000, token, "firstBlood", "epoch:first-blood"]);
    expect(stale).toBe(0);

    await upstashPipeline([["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY, CLAIM_GEN_KEY, SWITCH_KEY]]);
  });

  it("OUTBOX_CLAIM_SCRIPT refuses a lease while the switch is disabled", async () => {
    const entry = { kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "pending", webhookGeneration: Number(CLAIM_GEN), kindEpoch: 0 };
    await upstashPipeline([
      ["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY, SWITCH_KEY],
      ["SET", CLAIM_GEN_KEY, CLAIM_GEN],
      ["HSET", OUTBOX_KEY, CLAIM_ID, JSON.stringify(entry)],
      ["HSET", SWITCH_KEY, "firstBlood", "0", "epoch:first-blood", "0"],
    ]);

    const res = await upstashEval(OUTBOX_CLAIM_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY, SWITCH_KEY, CLAIM_GEN_KEY], [CLAIM_ID, "pending", 0, 90_000, `${RUN}-disabled`, "firstBlood", "epoch:first-blood"]);
    expect(res).toBe(0);
    const [lease] = await upstashPipeline([["GET", CLAIM_LEASE_KEY]]);
    expect(lease.result).toBeNull();

    await upstashPipeline([["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY, CLAIM_GEN_KEY, SWITCH_KEY]]);
  });

  it("OUTBOX_CLAIM_SCRIPT refuses a lease when the entry's kind epoch is stale", async () => {
    const entry = { kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "pending", webhookGeneration: Number(CLAIM_GEN), kindEpoch: 1 };
    await upstashPipeline([
      ["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY, SWITCH_KEY],
      ["SET", CLAIM_GEN_KEY, CLAIM_GEN],
      ["HSET", OUTBOX_KEY, CLAIM_ID, JSON.stringify(entry)],
      ["HSET", SWITCH_KEY, "firstBlood", "1", "epoch:first-blood", "2"],
    ]);

    const res = await upstashEval(OUTBOX_CLAIM_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY, SWITCH_KEY, CLAIM_GEN_KEY], [CLAIM_ID, "pending", 0, 90_000, `${RUN}-stale-epoch`, "firstBlood", "epoch:first-blood"]);
    expect(res).toBe(0);
    const [lease] = await upstashPipeline([["GET", CLAIM_LEASE_KEY]]);
    expect(lease.result).toBeNull();

    await upstashPipeline([["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY, CLAIM_GEN_KEY, SWITCH_KEY]]);
  });

  it("OUTBOX_ENQUEUE_SCRIPT writes only when the switch is on and the captured epoch and generation are current", async () => {
    const generationKey = liveKey("announce-enqueue", "generation");
    const id = `${RUN}-enqueue`;
    const entry = JSON.stringify({ kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "pending", kindEpoch: 2 });

    await upstashPipeline([
      ["DEL", OUTBOX_KEY, SWITCH_KEY, generationKey],
      ["SET", generationKey, "3"],
      ["HSET", SWITCH_KEY, "firstBlood", "1", "epoch:first-blood", "2"],
    ]);

    // Stale epoch: the switch was disabled and re-enabled after this
    // producer's config read.
    const staleEpoch = await upstashEval(OUTBOX_ENQUEUE_SCRIPT, [OUTBOX_KEY, SWITCH_KEY, generationKey], [`${id}-stale-epoch`, entry, 3, 1, "firstBlood", "epoch:first-blood"]);
    expect(staleEpoch).toBe(0);

    // Stale generation: the webhook rotated after this producer's read.
    const staleGeneration = await upstashEval(OUTBOX_ENQUEUE_SCRIPT, [OUTBOX_KEY, SWITCH_KEY, generationKey], [`${id}-stale-gen`, entry, 2, 2, "firstBlood", "epoch:first-blood"]);
    expect(staleGeneration).toBe(0);

    // Disabled switch: the captured epoch alone is not enough.
    await upstashPipeline([["HSET", SWITCH_KEY, "firstBlood", "0"]]);
    const disabled = await upstashEval(OUTBOX_ENQUEUE_SCRIPT, [OUTBOX_KEY, SWITCH_KEY, generationKey], [`${id}-disabled`, entry, 3, 2, "firstBlood", "epoch:first-blood"]);
    expect(disabled).toBe(0);

    // Current switch, epoch and generation: the write lands.
    await upstashPipeline([["HSET", SWITCH_KEY, "firstBlood", "1"]]);
    const accepted = await upstashEval(OUTBOX_ENQUEUE_SCRIPT, [OUTBOX_KEY, SWITCH_KEY, generationKey], [id, entry, 3, 2, "firstBlood", "epoch:first-blood"]);
    expect(accepted).toBe(1);
    const [raw] = await upstashPipeline([["HGET", OUTBOX_KEY, id]]);
    expect(raw.result).toBe(entry);

    await upstashPipeline([["DEL", OUTBOX_KEY, SWITCH_KEY, generationKey]]);
  });

  it("OUTBOX_COMPLETE_SCRIPT writes only for the current lease owner", async () => {
    const entry = { kind: "first-blood", payload: {}, at: new Date().toISOString(), n: 0, status: "pending" };
    const token = `${RUN}-complete-owner`;
    const sent = { ...entry, status: "sent" };

    await upstashPipeline([
      ["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY],
      ["HSET", OUTBOX_KEY, CLAIM_ID, JSON.stringify(entry)],
      ["SET", CLAIM_LEASE_KEY, token, "PX", 90_000, "NX"],
    ]);

    const wrong = await upstashEval(OUTBOX_COMPLETE_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY], [`${RUN}-stale`, CLAIM_ID, JSON.stringify(sent)]);
    expect(wrong).toBe(0);
    const [beforeComplete] = await upstashPipeline([["HGET", OUTBOX_KEY, CLAIM_ID]]);
    expect(JSON.parse(beforeComplete.result as string).status).toBe("pending");

    const won = await upstashEval(OUTBOX_COMPLETE_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY], [token, CLAIM_ID, JSON.stringify(sent)]);
    expect(won).toBe(1);
    const [afterComplete] = await upstashPipeline([["HGET", OUTBOX_KEY, CLAIM_ID], ["GET", CLAIM_LEASE_KEY]]);
    expect(JSON.parse(afterComplete.result as string).status).toBe("sent");
    const [leaseAfter] = await upstashPipeline([["GET", CLAIM_LEASE_KEY]]);
    expect(leaseAfter.result).toBeNull();

    const again = await upstashEval(OUTBOX_COMPLETE_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY], [token, CLAIM_ID, JSON.stringify(sent)]);
    expect(again).toBe(0);

    await upstashPipeline([["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY]]);
  });

  it("OUTBOX_SKIP_SCRIPT cancels pending/failed entries but never a terminal one", async () => {
    const base = { kind: "launch", payload: {}, at: new Date().toISOString() };
    const pending = { ...base, n: 0, status: "pending" };
    const failed = { ...base, n: 1, status: "failed" };
    const sent = { ...base, n: 0, status: "sent" };

    await upstashPipeline([
      ["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY],
      ["HSET", OUTBOX_KEY, `${RUN}-skip-pending`, JSON.stringify(pending), `${RUN}-skip-failed`, JSON.stringify(failed), `${RUN}-skip-sent`, JSON.stringify(sent)],
      ["SET", CLAIM_LEASE_KEY, `${RUN}-skip-owner`, "PX", 90_000, "NX"],
    ]);

    const skipPending = await upstashEval(OUTBOX_SKIP_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY], [`${RUN}-skip-pending`]);
    expect(skipPending).toBe(1);
    const skipFailed = await upstashEval(OUTBOX_SKIP_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY], [`${RUN}-skip-failed`]);
    expect(skipFailed).toBe(1);
    const skipSent = await upstashEval(OUTBOX_SKIP_SCRIPT, [OUTBOX_KEY, CLAIM_LEASE_KEY], [`${RUN}-skip-sent`]);
    expect(skipSent).toBe(0);

    const [pendingRaw, failedRaw, sentRaw, lease] = await upstashPipeline([
      ["HGET", OUTBOX_KEY, `${RUN}-skip-pending`],
      ["HGET", OUTBOX_KEY, `${RUN}-skip-failed`],
      ["HGET", OUTBOX_KEY, `${RUN}-skip-sent`],
      ["GET", CLAIM_LEASE_KEY],
    ]);
    expect(JSON.parse(pendingRaw.result as string).status).toBe("skipped");
    expect(JSON.parse(failedRaw.result as string).status).toBe("skipped");
    expect(JSON.parse(sentRaw.result as string).status).toBe("sent");
    expect(lease.result).toBeNull();

    await upstashPipeline([["DEL", OUTBOX_KEY, CLAIM_LEASE_KEY]]);
  });

  it("SWITCH_DISABLE_SCRIPT writes switches and advances only the disabled kinds' epochs", async () => {
    await upstashPipeline([
      ["DEL", SWITCH_KEY],
      ["HSET", SWITCH_KEY, "firstBlood", "1", "launch", "1", "epoch:first-blood", "4", "epoch:pause", "2", "epoch:resume", "2", "epoch:milestone", "3"],
    ]);
    const res = await upstashEval(SWITCH_DISABLE_SCRIPT, [SWITCH_KEY], [
      "2",
      "firstBlood", "0",
      "launch", "1",
      "epoch:first-blood",
      "epoch:pause",
      "epoch:resume",
    ]);
    expect(res).toBe(1);
    const [flat] = await upstashPipeline([["HGETALL", SWITCH_KEY]]);
    const config = new Map<string, string>();
    const arr = flat.result as string[];
    for (let i = 0; i < arr.length; i += 2) config.set(arr[i], arr[i + 1]);
    expect(config.get("firstBlood")).toBe("0");
    expect(config.get("launch")).toBe("1");
    expect(config.get("epoch:first-blood")).toBe("5");
    expect(config.get("epoch:pause")).toBe("3");
    expect(config.get("epoch:resume")).toBe("3");
    expect(config.get("epoch:milestone")).toBe("3");
    await upstashPipeline([["DEL", SWITCH_KEY]]);
  });

  it("WEBHOOK_TARGET_SCRIPT reads the URL and generation as one coherent snapshot across a clear/re-arm", async () => {
    const oldUrl = "https://discord.com/api/webhooks/1/retired";
    const newUrl = "https://discord.com/api/webhooks/2/current";
    await upstashPipeline([
      ["DEL", TARGET_URL_KEY, TARGET_GEN_KEY],
      ["SET", TARGET_URL_KEY, oldUrl],
      ["SET", TARGET_GEN_KEY, "0"],
    ]);

    // Each rotation clears the webhook (generation++ and URL delete, one
    // EVAL) then arms a new URL. Racing the reader against that must only
    // ever yield a state Redis actually held: the old pair, no URL with the
    // advanced generation, or a new URL with that generation — never the
    // retired URL carrying a newer generation.
    const rotations = Array.from({ length: 25 }, async (_, i) => {
      const [target] = await Promise.all([
        upstashEval(WEBHOOK_TARGET_SCRIPT, [TARGET_URL_KEY, TARGET_GEN_KEY], []) as Promise<[string, string]>,
        (async () => {
          await upstashEval(WEBHOOK_CLEAR_SCRIPT, [TARGET_URL_KEY, TARGET_GEN_KEY], []);
          await upstashPipeline([["SET", TARGET_URL_KEY, `${newUrl}-${i}`]]);
        })(),
      ]);
      return target;
    });
    const results = await Promise.all(rotations);
    for (const [url, generation] of results) {
      if (url === oldUrl) {
        expect(generation).toBe("0");
      } else if (url.startsWith(newUrl)) {
        expect(Number(generation)).toBeGreaterThan(0);
      } else {
        expect(url).toBe("");
        expect(Number(generation)).toBeGreaterThan(0);
      }
    }
  });

  it("STATE_CAS_ENQUEUE_SCRIPT refuses a stale observation BEFORE advancing the pack", async () => {
    const stateKey = liveKey("announce-cas-enq", "state");
    const seqKey = liveKey("announce-cas-enq", "seq");
    const boxKey = liveKey("announce-cas-enq", "box");
    const cfgKey = liveKey("announce-cas-enq", "config");
    const genKey = liveKey("announce-cas-enq", "generation");
    const keys = [stateKey, seqKey, boxKey, cfgKey, genKey];
    const entry = JSON.stringify({
      kind: "launch",
      payload: { embeds: [] },
      at: new Date().toISOString(),
      n: 0,
      status: "pending",
      webhookGeneration: 5,
      kindEpoch: 4,
    });
    const fresh = ["v1|L0P0", "v1|L1P0", new Date().toISOString(), "1", `${RUN}-enq-launch`, entry, "launch", "epoch:launch", "4", "5"];

    await upstashPipeline([
      ["DEL", stateKey, seqKey, boxKey, cfgKey, genKey],
      ["SET", stateKey, "v1|L0P0"],
      ["SET", genKey, "5"],
      ["HSET", cfgKey, "launch", "1", "epoch:launch", "4"],
    ]);

    // Stale kind epoch: the switch was disabled and re-enabled after this
    // observation's config read. Validation must refuse BEFORE the swap —
    // otherwise the swap consumes the edge and the enqueue check then drops
    // the entry, so the notice is lost while a later resume still fires.
    const staleEpoch = await upstashEval(STATE_CAS_ENQUEUE_SCRIPT, keys, [
      "v1|L0P0", "v1|L1P0", new Date().toISOString(), "1",
      `${RUN}-enq-epoch`, entry, "launch", "epoch:launch", "3", "5",
    ]);
    expect((staleEpoch as number[])[0]).toBe(0);

    // Stale webhook generation: the webhook rotated after this observation.
    const staleGeneration = await upstashEval(STATE_CAS_ENQUEUE_SCRIPT, keys, [
      "v1|L0P0", "v1|L1P0", new Date().toISOString(), "1",
      `${RUN}-enq-gen`, entry, "launch", "epoch:launch", "4", "4",
    ]);
    expect((staleGeneration as number[])[0]).toBe(0);

    // Switch turned off after the observation.
    await upstashPipeline([["HSET", cfgKey, "launch", "0"]]);
    const disabled = await upstashEval(STATE_CAS_ENQUEUE_SCRIPT, keys, fresh);
    expect((disabled as number[])[0]).toBe(0);
    await upstashPipeline([["HSET", cfgKey, "launch", "1"]]);

    // Nothing moved: the pack still holds the observed value, the seq was
    // not bumped, and no half-written entry landed.
    const [pack, seq, box] = await upstashPipeline([
      ["GET", stateKey],
      ["GET", seqKey],
      ["HGETALL", boxKey],
    ]);
    expect(pack.result).toBe("v1|L0P0");
    expect(seq.result).toBeNull();
    expect(box.result).toEqual([]);

    // A current observation wins the swap AND writes the entry atomically.
    const accepted = await upstashEval(STATE_CAS_ENQUEUE_SCRIPT, keys, fresh);
    const arr = accepted as [number, number, string, number];
    expect(arr[0]).toBe(1);
    expect(arr[3]).toBe(1);
    const [pack2, box2] = await upstashPipeline([["GET", stateKey], ["HGET", boxKey, `${RUN}-enq-launch`]]);
    expect(pack2.result).toBe("v1|L1P0");
    expect(box2.result).toBe(entry);

    await upstashPipeline([["DEL", stateKey, seqKey, boxKey, cfgKey, genKey]]);
  });

  it("SET_ANNOUNCE_COOLDOWN_SCRIPT keeps the LATEST deadline when a shorter one arrives last", async () => {
    const key = liveKey("announce-cooldown", "deadline");
    await upstashPipeline([["DEL", key]]);
    const now = Date.now();
    const longUntil = now + 60_000;
    const shortUntil = now + 5_000;

    await upstashEval(SET_ANNOUNCE_COOLDOWN_SCRIPT, [key], [String(longUntil), String(now)]);
    // Another replica's 429 carries a shorter restriction and writes after:
    // it must not shorten the deadline already parked, or delivery would
    // resume before the stricter restriction ends.
    await upstashEval(SET_ANNOUNCE_COOLDOWN_SCRIPT, [key], [String(shortUntil), String(now)]);

    const [deadline, ttl] = await upstashPipeline([["GET", key], ["PTTL", key]]);
    expect(deadline.result).toBe(String(longUntil));
    expect(Number(ttl.result)).toBeGreaterThan(40_000);

    // The other order still extends: a longer deadline arriving last wins.
    const longerUntil = now + 90_000;
    await upstashEval(SET_ANNOUNCE_COOLDOWN_SCRIPT, [key], [String(longerUntil), String(now)]);
    const [extended] = await upstashPipeline([["GET", key]]);
    expect(extended.result).toBe(String(longerUntil));

    await upstashPipeline([["DEL", key]]);
  });
});
