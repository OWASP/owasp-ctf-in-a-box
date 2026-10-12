// Score adjustments (#591): a signed points change for a TEAM, with a
// required reason, set from /admin. Its own ledger, never mixed into hint
// spend or solves; every add and remove lands with its audit line in one
// atomic script.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ upstashEval: vi.fn(), upstashPipeline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/upstash", () => ({ upstashEval: m.upstashEval, upstashPipeline: m.upstashPipeline }));
vi.mock("@/lib/admin-store", () => ({ ADMIN_AUDIT_KEY: "ctf:admin:audit", AUDIT_CAP: 500 }));

import {
  ADJUSTMENTS_KEY,
  AdjustmentValidationError,
  addAdjustment,
  listAdjustments,
  removeAdjustment,
  teamAdjustments,
} from "@/lib/adjustments-store";

beforeEach(() => vi.clearAllMocks());

const row = (id: string, slug: string, points: number, reason = "r") =>
  JSON.stringify({ id, slug, points, reason, by: "admin", at: "2026-10-09T17:00:00.000Z" });

describe("addAdjustment", () => {
  it("writes the row and its audit line in one script, keyed by a fresh id", async () => {
    m.upstashEval.mockResolvedValueOnce("ok");
    const adj = await addAdjustment("Red-Team", -10, "  late flag sharing  ", "admin");
    expect(adj).toMatchObject({ slug: "red-team", points: -10, reason: "late flag sharing", by: "admin" });
    const [script, keys, args] = m.upstashEval.mock.calls[0];
    expect(script).toContain("HSET");
    expect(script).toContain("LPUSH");
    expect(keys).toEqual([ADJUSTMENTS_KEY, "ctf:team:red-team", "ctf:admin:audit"]);
    expect(JSON.parse(String(args[1]))).toMatchObject({ id: adj.id, points: -10 });
    expect(JSON.parse(String(args[2]))).toMatchObject({ action: "adjustment:add", by: "admin", slug: "red-team", points: -10 });
  });

  it.each([
    ["zero points", 0, "reason"],
    ["a fraction", 1.5, "reason"],
    ["a huge figure", 100001, "reason"],
    ["no reason", 5, "   "],
    ["a long reason", 5, "x".repeat(201)],
  ])("refuses %s without writing", async (_what, points, reason) => {
    await expect(addAdjustment("red-team", points, reason, "admin")).rejects.toBeInstanceOf(AdjustmentValidationError);
    expect(m.upstashEval).not.toHaveBeenCalled();
  });

  it("refuses a team that does not exist", async () => {
    m.upstashEval.mockResolvedValueOnce("no-team");
    await expect(addAdjustment("ghost", 5, "bonus", "admin")).rejects.toThrow(/No team "ghost"/);
  });
});

describe("removeAdjustment", () => {
  it("deletes the row and records the removal in one script", async () => {
    m.upstashEval.mockResolvedValueOnce(row("a1", "red", -10));
    await removeAdjustment("a1", "admin");
    const [script, keys, args] = m.upstashEval.mock.calls[0];
    expect(script).toContain("HDEL");
    expect(keys).toEqual([ADJUSTMENTS_KEY, "ctf:admin:audit"]);
    expect(args[0]).toBe("a1");
  });

  it("answers the removed row", async () => {
    m.upstashEval.mockResolvedValueOnce(row("a1", "red", -10));
    expect(await removeAdjustment("a1", "admin")).toMatchObject({ id: "a1", row: { slug: "red", points: -10 } });
  });

  // The script removed and audited it; an unreadable row must not turn that
  // into an error the organizer would retry.
  it("reports a malformed row's removal as done, with no row", async () => {
    m.upstashEval.mockResolvedValueOnce("{not json");
    expect(await removeAdjustment("a1", "admin")).toEqual({ id: "a1", row: null });
  });

  it("refuses with nothing changed when the audit log cannot take the line", async () => {
    m.upstashEval.mockResolvedValueOnce("audit-unwritable");
    await expect(removeAdjustment("a1", "admin")).rejects.toThrow(/nothing was changed/);
  });

  it("says so when the id is not there", async () => {
    m.upstashEval.mockResolvedValueOnce(null);
    await expect(removeAdjustment("nope", "admin")).rejects.toThrow(/No adjustment/);
  });
});

describe("reading the ledger", () => {
  it("lists rows newest first and sums them per team", async () => {
    m.upstashPipeline.mockResolvedValue([{ result: ["a1", row("a1", "red", -10), "a2", row("a2", "red", 50), "a3", row("a3", "blue", 5)] }]);
    expect((await listAdjustments()).map((a) => a.id)).toHaveLength(3);
    expect(await teamAdjustments()).toEqual(new Map([["red", 40], ["blue", 5]]));
  });

  it("throws on a failed read, so the caller's fail direction applies", async () => {
    m.upstashPipeline.mockResolvedValue([{ error: "WRONGTYPE" }]);
    await expect(listAdjustments()).rejects.toThrow(/WRONGTYPE/);
  });

  it("skips an unparseable row rather than failing the board", async () => {
    m.upstashPipeline.mockResolvedValue([{ result: ["a1", "{not json", "a2", row("a2", "red", 7)] }]);
    expect(await teamAdjustments()).toEqual(new Map([["red", 7]]));
  });
});
