// The score-adjustment scripts EXECUTED against a live Redis on run-unique
// keys: an add writes the row and its audit line together and refuses a
// missing team; a remove deletes the row and records it, and is a no-op for
// an unknown id. See live-redis.ts for the harness.

import { afterAll, describe, expect, it, vi } from "vitest";
import { liveConfigured, liveKey } from "./live-redis";

vi.mock("server-only", () => ({}));

describe.skipIf(!liveConfigured)("score-adjustment scripts against a live Redis", () => {
  const K = {
    ledger: liveKey("adj", "ledger"),
    team: liveKey("adj", "team"),
    audit: liveKey("adj", "audit"),
    badAudit: liveKey("adj", "bad-audit"),
  };

  async function load() {
    const store = await import("@/lib/adjustments-store");
    const { upstashEval, upstashPipeline } = await import("@/lib/upstash");
    return { store, upstashEval, pipeline: upstashPipeline };
  }

  afterAll(async () => {
    const { pipeline } = await load();
    await pipeline([["DEL", ...Object.values(K)]]);
  });

  it("adds with its audit line, refuses a missing team, removes with a record, and ignores an unknown id", async () => {
    const { store, upstashEval, pipeline } = await load();
    const row = JSON.stringify({ id: "a1", slug: "red", points: -10, reason: "r", by: "admin", at: "t" });
    expect(await upstashEval(store.ADD_SCRIPT, [K.ledger, K.team, K.audit], ["a1", row, "add-line", "1"])).toBe("no-team");
    const [n0, l0] = await pipeline([["HLEN", K.ledger], ["LLEN", K.audit]]);
    expect([n0.result, l0.result]).toEqual([0, 0]);

    await pipeline([["HSET", K.team, "name", "Red"]]);
    expect(await upstashEval(store.ADD_SCRIPT, [K.ledger, K.team, K.audit], ["a1", row, "add-line", "1"])).toBe("ok");
    const [r1, a1] = await pipeline([["HGET", K.ledger, "a1"], ["LRANGE", K.audit, 0, -1]]);
    expect(r1.result).toBe(row);
    expect(a1.result).toEqual(["add-line"]);

    expect(await upstashEval(store.REMOVE_SCRIPT, [K.ledger, K.audit], ["a1", "admin", "t2", "1"])).toBe(row);
    const [r2, a2] = await pipeline([["HEXISTS", K.ledger, "a1"], ["LRANGE", K.audit, 0, -1]]);
    expect(r2.result).toBe(0);
    const removal = JSON.parse((a2.result as string[])[0]);
    expect(removal).toMatchObject({ action: "adjustment:remove", by: "admin", id: "a1", row: { points: -10 } });

    expect(await upstashEval(store.REMOVE_SCRIPT, [K.ledger, K.audit], ["nope", "admin", "t3", "1"])).toBeNull();
    const [a3] = await pipeline([["LLEN", K.audit]]);
    expect(a3.result).toBe(2);
  });

  // A ledger change and its audit line land together or not at all: Redis
  // does not undo an earlier write when a later command in a script fails, so
  // an audit key that cannot take the line is refused before anything moves.
  it("refuses an add or a remove when the audit key is not a list, changing nothing", async () => {
    const { store, upstashEval, pipeline } = await load();
    const row = JSON.stringify({ id: "b1", slug: "red", points: 5, reason: "r", by: "admin", at: "t" });
    await pipeline([["HSET", K.team, "name", "Red"], ["SET", K.badAudit, "not a list"]]);
    expect(await upstashEval(store.ADD_SCRIPT, [K.ledger, K.team, K.badAudit], ["b1", row, "line", "1"])).toBe("audit-unwritable");
    const [n] = await pipeline([["HEXISTS", K.ledger, "b1"]]);
    expect(n.result).toBe(0);

    await pipeline([["HSET", K.ledger, "b2", row]]);
    expect(await upstashEval(store.REMOVE_SCRIPT, [K.ledger, K.badAudit], ["b2", "admin", "t", "1"])).toBe("audit-unwritable");
    const [kept] = await pipeline([["HEXISTS", K.ledger, "b2"]]);
    expect(kept.result).toBe(1);
  });

  // A row that is not valid JSON is still removable, and the audit line
  // carries it as text rather than the script failing after the delete.
  it("removes an unparseable row and records it as text", async () => {
    const { store, upstashEval, pipeline } = await load();
    await pipeline([["DEL", K.audit], ["HSET", K.ledger, "c1", "{not json"]]);
    expect(await upstashEval(store.REMOVE_SCRIPT, [K.ledger, K.audit], ["c1", "admin", "t", "1"])).toBe("{not json");
    const [gone, line] = await pipeline([["HEXISTS", K.ledger, "c1"], ["LINDEX", K.audit, 0]]);
    expect(gone.result).toBe(0);
    expect(JSON.parse(line.result as string)).toMatchObject({ action: "adjustment:remove", id: "c1", row: "{not json" });
  });
});
