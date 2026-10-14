// Integration tests for the announcer's atomicity primitives (#590), against
// a REAL Redis behind srh: the lifecycle/board compare-and-swap Lua (exactly
// one replica announces a transition) and the HSETNX dedup ledgers (exactly
// one caller wins a first-blood/release/daily claim). These are the only
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
import { STATE_CAS_SCRIPT, claimLedgerField, claimLedgerFields } from "@/lib/announce/store";

const STATE_KEY = liveKey("announce-cas", "state");
const SEQ_KEY = liveKey("announce-cas", "seq");
const LEDGER_KEY = liveKey("announce-cas", "ledger");
const LEASE_ID = `${RUN}-lease`;
const LEASE_KEY = `ctf:announce:lease:${LEASE_ID}`;

describe.skipIf(!liveConfigured)("announce CAS + claims (live Redis)", () => {
  beforeAll(async () => {
    await upstashPipeline([["DEL", STATE_KEY, SEQ_KEY, LEDGER_KEY, LEASE_KEY]]);
  });

  afterAll(async () => {
    await upstashPipeline([["DEL", STATE_KEY, SEQ_KEY, LEDGER_KEY, LEASE_KEY]]);
  });

  it("first observation with expected='' seeds silently (code 2) and bumps the seq", async () => {
    const res = (await upstashEval(STATE_CAS_SCRIPT, [STATE_KEY, SEQ_KEY], ["", "v1|L1P0R0"])) as [number, number, string];
    expect(res[0]).toBe(2);
    expect(res[1]).toBe(1);
    const [get] = await upstashPipeline([["GET", STATE_KEY]]);
    expect(get.result).toBe("v1|L1P0R0");
  });

  it("the matching expected pack wins the swap (code 1); a stale expected does not (code 0)", async () => {
    // Same expected as the CURRENT value: this replica owns the edge.
    const win = (await upstashEval(STATE_CAS_SCRIPT, [STATE_KEY, SEQ_KEY], ["v1|L1P0R0", "v1|L1P1R0"])) as [number, number, string];
    expect(win[0]).toBe(1);
    expect(win[1]).toBe(2);
    expect(win[2]).toBe("v1|L1P0R0");
    // A second replica still holding the OLD pack loses.
    const lose = (await upstashEval(STATE_CAS_SCRIPT, [STATE_KEY, SEQ_KEY], ["v1|L1P0R0", "v1|L1P0R1"])) as [number, number, string];
    expect(lose[0]).toBe(0);
    // A replica that already matches the current value gets 0, not a re-announce.
    const same = (await upstashEval(STATE_CAS_SCRIPT, [STATE_KEY, SEQ_KEY], ["v1|L1P1R0", "v1|L1P1R0"])) as [number, number, string];
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
  });
});
