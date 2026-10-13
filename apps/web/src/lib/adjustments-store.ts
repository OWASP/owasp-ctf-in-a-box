// Score adjustments: a signed points change for a TEAM (a +50 bonus, a -10
// penalty), with a required reason, set from /admin. Before this the only
// lever was writing hint spend by hand in Redis, which the board labelled as
// hints, came out of one member's hint balance, and vanished when hints were
// switched off.
//
// Its own ledger (`ctf:adjustments`, id -> JSON row), never mixed into hint
// spend or module solves. Folded into the team's total LAST, after hint
// penalties (leaderboard/score-adjustments.ts); it moves points only, never
// the tie-break time. Scoring data, not configuration: the event archive
// does not carry it (it carries no solves either), and the master reset
// clears it. Every add and remove is written with its audit line in one
// atomic script, so the ledger never changes without a record of who and why.

import "server-only";
import { randomUUID } from "node:crypto";
import { ADMIN_AUDIT_KEY, AUDIT_CAP } from "@/lib/admin-store";
import { upstashEval, upstashPipeline } from "@/lib/upstash";
import { ADJUSTMENT_MAX, ADJUSTMENTS_KEY, isTeamSlug } from "@/lib/adjustment-keys";

export { ADJUSTMENT_MAX, ADJUSTMENTS_KEY };
export const ADJUSTMENT_REASON_MAX = 200;

export type Adjustment = { id: string; slug: string; points: number; reason: string; by: string; at: string };

export class AdjustmentValidationError extends Error {
  constructor(
    readonly field: "slug" | "points" | "reason" | "id",
    message: string,
  ) {
    super(message);
    this.name = "AdjustmentValidationError";
  }
}

// A script's earlier writes stay when a later command fails, so each one
// checks that the audit list can take its line before it touches the ledger:
// a change and its audit line land together or not at all.

// KEYS: [1]=ledger [2]=team hash [3]=audit list
// ARGV: [1]=id [2]=row JSON [3]=audit line [4]=audit cap index
// Exported for the live suite only.
export const ADD_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 0 then return 'no-team' end
local t = redis.call('TYPE', KEYS[3])['ok']
if t ~= 'none' and t ~= 'list' then return 'audit-unwritable' end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('LPUSH', KEYS[3], ARGV[3])
redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[4]))
return 'ok'`;

// KEYS: [1]=ledger [2]=audit list
// ARGV: [1]=id [2]=actor [3]=at [4]=audit cap index
// Answers the removed row, or nil when there was none. A row that is not
// valid JSON is still removed, and recorded as its text.
// Exported for the live suite only.
export const REMOVE_SCRIPT = `
local row = redis.call('HGET', KEYS[1], ARGV[1])
if not row then return nil end
local t = redis.call('TYPE', KEYS[2])['ok']
if t ~= 'none' and t ~= 'list' then return 'audit-unwritable' end
local ok, decoded = pcall(cjson.decode, row)
local line = cjson.encode({ at = ARGV[3], by = ARGV[2], action = 'adjustment:remove', id = ARGV[1], row = ok and decoded or row })
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('LPUSH', KEYS[2], line)
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[4]))
return row`;

export async function addAdjustment(rawSlug: string, points: number, rawReason: string, actor: string): Promise<Adjustment> {
  const slug = rawSlug.trim().toLowerCase();
  if (!isTeamSlug(slug)) throw new AdjustmentValidationError("slug", `'${rawSlug}' is not a team slug`);
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > ADJUSTMENT_MAX) {
    throw new AdjustmentValidationError("points", `points must be a whole number, not 0, between -${ADJUSTMENT_MAX} and ${ADJUSTMENT_MAX}`);
  }
  const reason = rawReason.trim();
  if (!reason) throw new AdjustmentValidationError("reason", "a reason is required");
  if (reason.length > ADJUSTMENT_REASON_MAX) {
    throw new AdjustmentValidationError("reason", `the reason must be ${ADJUSTMENT_REASON_MAX} characters or fewer`);
  }
  const adj: Adjustment = { id: randomUUID(), slug, points, reason, by: actor, at: new Date().toISOString() };
  const audit = JSON.stringify({ at: adj.at, by: actor, action: "adjustment:add", id: adj.id, slug, points, reason });
  const verdict = await upstashEval(
    ADD_SCRIPT,
    [ADJUSTMENTS_KEY, `ctf:team:${slug}`, ADMIN_AUDIT_KEY],
    [adj.id, JSON.stringify(adj), audit, String(AUDIT_CAP - 1)],
  );
  if (verdict === "no-team") throw new AdjustmentValidationError("slug", `No team "${slug}"`);
  if (verdict === "audit-unwritable") throw new Error("the admin audit log is not writable; nothing was changed");
  if (verdict !== "ok") throw new Error(`unexpected verdict from the adjustment script: ${String(verdict)}`);
  return adj;
}

/** Removes one adjustment and answers its row, or `row: null` when the stored
 *  text was not a readable row: it was still removed and audited. */
export async function removeAdjustment(id: string, actor: string): Promise<{ id: string; row: Adjustment | null }> {
  const removed = await upstashEval(REMOVE_SCRIPT, [ADJUSTMENTS_KEY, ADMIN_AUDIT_KEY], [id, actor, new Date().toISOString(), String(AUDIT_CAP - 1)]);
  if (removed === "audit-unwritable") throw new Error("the admin audit log is not writable; nothing was changed");
  if (typeof removed !== "string") throw new AdjustmentValidationError("id", `No adjustment "${id}"`);
  return { id, row: parseRow(removed) };
}

function parseRow(raw: unknown): Adjustment | null {
  if (typeof raw !== "string") return null;
  try {
    const row = JSON.parse(raw) as Partial<Adjustment>;
    if (typeof row.id !== "string" || typeof row.slug !== "string" || !Number.isInteger(row.points)) return null;
    return {
      id: row.id,
      slug: row.slug,
      points: row.points as number,
      reason: String(row.reason ?? ""),
      by: String(row.by ?? ""),
      at: String(row.at ?? ""),
    };
  } catch {
    return null;
  }
}

/** Every adjustment, newest first. Throws on a failed read so the caller's
 *  fail direction applies; an unparseable row is skipped. */
export async function listAdjustments(): Promise<Adjustment[]> {
  const [res] = await upstashPipeline([["HGETALL", ADJUSTMENTS_KEY]]);
  if (res?.error) throw new Error(`adjustments read failed: ${res.error}`);
  const flat = Array.isArray(res?.result) ? (res.result as unknown[]) : [];
  const rows: Adjustment[] = [];
  for (let i = 1; i < flat.length; i += 2) {
    const row = parseRow(flat[i]);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** Net adjustment per team slug. */
export async function teamAdjustments(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const a of await listAdjustments()) out.set(a.slug, (out.get(a.slug) ?? 0) + a.points);
  return out;
}
