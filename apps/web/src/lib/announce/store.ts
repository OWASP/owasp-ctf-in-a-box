// Redis persistence for the Discord announcer (#590). `server-only`: the
// webhook URL lives here and must never be reachable from a client bundle.
//
// Three responsibilities, deliberately in ONE file because they share the
// key family and the fail directions:
//
//   1. CONFIG — the per-type switches/options (`ctf:admin:discord`) and the
//      webhook URL (`ctf:admin:discord:webhook`, its own key so the config
//      hash can be read into an API response without the secret in it).
//      Survives the master reset, like `ctf:admin:settings`.
//   2. STATE — the dedup ledgers, the lifecycle/board CAS state and the
//      delivery outbox (`ctf:announce:*`). Wiped by the master reset, so a
//      fresh run re-announces its own launches and first bloods.
//   3. CAS — a tiny Lua script that makes "exactly one replica announces
//      this transition" an atomic decision (compare observed pack, swap to
//      next pack, bump the seq id) rather than a read-modify-write race.
//
// Fail directions, uniformly: every reader here FAILS OPEN (an unavailable
// Redis means no announcement, never a thrown error that could take a
// contestant-facing request down with it); every writer reports its failure
// to the caller and logs a label only, never a value, because the values
// here include the webhook URL.

import "server-only";
import { upstashPipeline, upstashEval } from "@/lib/upstash";
import { adminErrorLabel, writeAdminAudit } from "@/lib/admin-store";
import {
  ANNOUNCEMENT_KINDS,
  DISCORD_DEFAULTS,
  checkDailyAt,
  checkDailyTopN,
  checkDiscordWebhookUrl,
  checkLeaderScope,
  parseMarks,
  type AnnouncementKind,
  type DiscordConfigPatch,
  type DiscordFullConfig,
  type DiscordPublicConfig,
} from "@/lib/discord-config";
import {
  ANNOUNCE_BOARD_KEY,
  ANNOUNCE_LEASE_MS,
  ANNOUNCE_LEASE_PREFIX,
  ANNOUNCE_LIFECYCLE_KEY,
  ANNOUNCE_MAX_ATTEMPTS,
  ANNOUNCE_OUTBOX_KEY,
  ANNOUNCE_SEQ_KEY,
  ANNOUNCE_STATUS_KEY,
  DISCORD_CONFIG_KEY,
  DISCORD_WEBHOOK_KEY,
} from "./keys";

// --- config ------------------------------------------------------------------

/** A field-level validation refusal from updateAnnounceConfig /
 *  setAnnounceWebhook. Distinct from a store failure so the admin route can
 *  answer 400 with the message rather than 503. */
export class AnnounceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnnounceValidationError";
  }
}

/** Reads the config + webhook in ONE pipeline, then merges the switches over
 *  the defaults. An absent hash means all-off — configuring nothing IS the
 *  default state, so the announcer never runs unasked. */
export async function getAnnounceConfig(timeoutMs?: number): Promise<DiscordFullConfig> {
  try {
    const [cfgRes, urlRes] = await upstashPipeline([
      ["HGETALL", DISCORD_CONFIG_KEY],
      ["GET", DISCORD_WEBHOOK_KEY],
    ], timeoutMs === undefined ? undefined : { timeoutMs });
    const flat = Array.isArray(cfgRes.result) ? (cfgRes.result as string[]) : [];
    const raw: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) {
      if (typeof flat[i] === "string" && typeof flat[i + 1] === "string") raw[flat[i]] = flat[i + 1];
    }
    const webhookUrl = typeof urlRes.result === "string" && urlRes.result !== "" ? urlRes.result : null;
    return {
      webhookConfigured: webhookUrl !== null,
      releases: raw.releases === "1",
      firstBlood: raw.firstBlood === "1",
      leaders: raw.leaders === "1",
      leaderScope: raw.leaderScope === "top3" ? "top3" : "first",
      launch: raw.launch === "1",
      pause: raw.pause === "1",
      registration: raw.registration === "1",
      milestones: raw.milestones === "1",
      marks: typeof raw.marks === "string" ? raw.marks : DISCORD_DEFAULTS.marks,
      daily: raw.daily === "1",
      dailyAt: typeof raw.dailyAt === "string" && /^\d{2}:\d{2}$/.test(raw.dailyAt) ? raw.dailyAt : DISCORD_DEFAULTS.dailyAt,
      dailyTopN: Number.isInteger(Number(raw.dailyTopN)) && Number(raw.dailyTopN) >= 1 && Number(raw.dailyTopN) <= 50
        ? Number(raw.dailyTopN)
        : DISCORD_DEFAULTS.dailyTopN,
      webhookUrl,
    };
  } catch (err) {
    console.error("[announce] config read failed:", adminErrorLabel(err));
    return { ...DISCORD_DEFAULTS, webhookConfigured: false, webhookUrl: null };
  }
}

/** The client-safe half — the webhook URL is NOT destructured and dropped,
 *  it is never picked up: the return is built field-by-field from the public
 *  shape, so a field that must not leave the server cannot ride along by a
 *  spread or a forgotten omission. `webhookConfigured` is the flag the
 *  /admin section renders instead. */
export function publicConfig(config: DiscordFullConfig): DiscordPublicConfig {
  return {
    webhookConfigured: config.webhookConfigured,
    releases: config.releases,
    firstBlood: config.firstBlood,
    leaders: config.leaders,
    leaderScope: config.leaderScope,
    launch: config.launch,
    pause: config.pause,
    registration: config.registration,
    milestones: config.milestones,
    marks: config.marks,
    daily: config.daily,
    dailyAt: config.dailyAt,
    dailyTopN: config.dailyTopN,
  };
}

/** Validates a patch field-by-field and writes only the recognised,
 *  validated fields. Unknown keys are refused outright (same contract as
 *  updateAdminSettings), so a typo'd field is an error, not a silent no-op.
 *  Throws with a field-named message on any validation failure; writes
 *  nothing until every field in the patch has passed. */
export async function updateAnnounceConfig(actor: string, patch: DiscordConfigPatch): Promise<DiscordPublicConfig> {
  const boolKeys = ["releases", "firstBlood", "leaders", "launch", "pause", "registration", "milestones", "daily"] as const;
  const known = new Set<string>([...boolKeys, "leaderScope", "marks", "dailyAt", "dailyTopN"]);
  for (const key of Object.keys(patch)) {
    if (!known.has(key)) throw new AnnounceValidationError(`unknown setting: ${key}`);
  }

  const writes: [string, string][] = [];
  const changed: Partial<Omit<DiscordFullConfig, "webhookUrl">> = {};
  for (const key of boolKeys) {
    if (key in patch) {
      const v = patch[key];
      if (typeof v !== "boolean") throw new AnnounceValidationError(`${key} must be a boolean`);
      writes.push([key, v ? "1" : "0"]);
      changed[key] = v;
    }
  }
  if ("leaderScope" in patch) {
    const r = checkLeaderScope(patch.leaderScope);
    if (!r.ok) throw new AnnounceValidationError(r.message);
    writes.push(["leaderScope", r.value]);
    changed.leaderScope = r.value;
  }
  if ("marks" in patch) {
    const r = parseMarks(patch.marks);
    if (!r.ok) throw new AnnounceValidationError(r.message);
    const value = typeof patch.marks === "string" ? patch.marks.trim() : "";
    writes.push(["marks", value]);
    changed.marks = value;
  }
  if ("dailyAt" in patch) {
    const r = checkDailyAt(patch.dailyAt);
    if (!r.ok) throw new AnnounceValidationError(r.message);
    writes.push(["dailyAt", r.value]);
    changed.dailyAt = r.value;
  }
  if ("dailyTopN" in patch) {
    const r = checkDailyTopN(patch.dailyTopN);
    if (!r.ok) throw new AnnounceValidationError(r.message);
    writes.push(["dailyTopN", String(r.value)]);
    changed.dailyTopN = r.value;
  }

  if (writes.length > 0) {
    const [res] = await upstashPipeline([["HSET", DISCORD_CONFIG_KEY, ...writes.flat()]]);
    if (res.error) throw new Error(`config write failed: ${res.error}`);
  }
  if (Object.keys(changed).length > 0) {
    // The patch's values are all public prefs — no secret can be in here —
    // so recording them is safe and useful; the webhook URL never is.
    await writeAdminAudit(actor, "announce-config", changed);
  }
  // The response is the fresh read with this patch overlaid: the overlay
  // makes the returned config reflect what the caller just saved even if the
  // read back fails (getAnnounceConfig fails open to all-off), so a successful
  // save is never reported to the admin panel as "everything switched off".
  const current = await getAnnounceConfig();
  return publicConfig({ ...current, ...changed });
}

/** Stores or clears the webhook URL. `null` clears. The audit trail records
 *  ONLY "set"/"cleared" — never the URL, which is a live credential. */
export async function setAnnounceWebhook(actor: string, raw: unknown): Promise<{ webhookConfigured: boolean }> {
  if (raw === null) {
    const [res] = await upstashPipeline([["DEL", DISCORD_WEBHOOK_KEY]]);
    if (res.error) throw new Error(`webhook clear failed: ${res.error}`);
    await writeAdminAudit(actor, "announce-webhook", { state: "cleared" });
    return { webhookConfigured: false };
  }
  const checked = checkDiscordWebhookUrl(raw);
  if (!checked.ok) throw new AnnounceValidationError(checked.message);
  const [res] = await upstashPipeline([["SET", DISCORD_WEBHOOK_KEY, checked.value]]);
  if (res.error) throw new Error(`webhook write failed: ${res.error}`);
  // Seed-sweep claims everything already public, so saving a webhook never
  // replays the past — see ticker.seedReleaseClaims.
  await writeAdminAudit(actor, "announce-webhook", { state: "set" });
  return { webhookConfigured: true };
}

/** The webhook URL, for the sender's use ONLY. Never part of an API
 *  response; callers that need a boolean ask for `webhookConfigured`. */
export async function getWebhookUrl(): Promise<string | null> {
  try {
    const [res] = await upstashPipeline([["GET", DISCORD_WEBHOOK_KEY]]);
    return typeof res.result === "string" && res.result !== "" ? res.result : null;
  } catch (err) {
    console.error("[announce] webhook read failed:", adminErrorLabel(err));
    return null;
  }
}

// --- dedup ledgers -----------------------------------------------------------

/** Claims a field in one of the dedup ledgers (HSETNX). `true` = this
 *  caller won the claim and should announce; `false` = already claimed (by
 *  an earlier tick, another replica, or the seed sweep). The key is a
 *  parameter (not a closed union) so the live-Redis suite can claim against
 *  run-unique ledgers without ever touching the box's real ones. */
export async function claimLedgerField(ledgerKey: string, field: string): Promise<boolean> {
  const [res] = await upstashPipeline([["HSETNX", ledgerKey, field, new Date().toISOString()]]);
  if (res.error) {
    console.error("[announce] ledger claim failed:", adminErrorLabel(new Error(res.error)));
    return false; // a claim we cannot record must not double-post
  }
  return res.result === 1;
}

/** Bulk-claims many fields in one pipeline, returning which ones this caller
 *  won. Used by the release sweep and the seed sweep. */
export async function claimLedgerFields(
  ledgerKey: string,
  fields: readonly string[],
): Promise<Set<string>> {
  if (fields.length === 0) return new Set();
  const now = new Date().toISOString();
  const results = await upstashPipeline(fields.map((f) => ["HSETNX", ledgerKey, f, now]));
  const won = new Set<string>();
  results.forEach((res, i) => {
    if (res.error) {
      console.error("[announce] ledger claim failed:", adminErrorLabel(new Error(res.error)));
    } else if (res.result === 1) {
      won.add(fields[i]);
    }
  });
  return won;
}

/** The currently-claimed fields of a ledger, as a set. */
export async function ledgerFields(ledgerKey: string): Promise<Set<string>> {
  try {
    const [res] = await upstashPipeline([["HKEYS", ledgerKey]]);
    const flat = Array.isArray(res.result) ? (res.result as string[]) : [];
    return new Set(flat.filter((f): f is string => typeof f === "string"));
  } catch (err) {
    console.error("[announce] ledger read failed:", adminErrorLabel(err));
    return new Set();
  }
}

// --- lifecycle / board CAS ---------------------------------------------------

/** The compare-and-swap result: `code` 2 = first observation (the state was
 *  seeded silently, nothing to announce), 1 = the observed transition is
 *  ours to announce, 0 = someone else got there first (or the state has
 *  already moved on since our read). `prev` is the pack we swapped FROM, so
 *  the caller can describe the edge. */
export type StateCasResult = { code: 0 | 1 | 2; seq: number; prev: string };

/** The CAS script itself, exported for the live-Redis suite, which runs it
 *  against run-unique keys (the store's own stateCompareSet uses the fixed
 *  ctf:announce:* keys, which must not be shared with test runs). */
export const STATE_CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur == false then
  if ARGV[1] == '' then
    local seq = redis.call('INCR', KEYS[2])
    redis.call('SET', KEYS[1], ARGV[2])
    return {2, seq, ''}
  end
  return {0, 0, ''}
end
if cur == ARGV[2] then return {0, 0, cur} end
if cur == ARGV[1] then
  local seq = redis.call('INCR', KEYS[2])
  redis.call('SET', KEYS[1], ARGV[2])
  return {1, seq, cur}
end
return {0, 0, cur}
`;

/** Runs the CAS against one of the two observed-state keys. `expected` is
 *  the pack this caller last read ('' when the key is absent); `next` is the
 *  pack derived from the CURRENT observation. Exactly one replica's `next`
 *  write can win per distinct transition, because the swap is atomic and the
 *  loser's `expected` no longer matches. */
export async function stateCompareSet(
  stateKey: typeof ANNOUNCE_LIFECYCLE_KEY | typeof ANNOUNCE_BOARD_KEY,
  expected: string,
  next: string,
): Promise<StateCasResult> {
  const raw = await upstashEval(STATE_CAS_SCRIPT, [stateKey, ANNOUNCE_SEQ_KEY], [expected, next, new Date().toISOString()]);
  const arr = Array.isArray(raw) ? (raw as unknown[]) : [];
  const code = Number(arr[0]);
  const seq = Number(arr[1]);
  const prev = typeof arr[2] === "string" ? arr[2] : "";
  return {
    code: (code === 1 || code === 2 ? code : 0) as 0 | 1 | 2,
    seq: Number.isFinite(seq) ? seq : 0,
    prev,
  };
}

/** The current observed-state pack, or null when the key is absent. */
export async function readStatePack(stateKey: typeof ANNOUNCE_LIFECYCLE_KEY | typeof ANNOUNCE_BOARD_KEY): Promise<string | null> {
  const [res] = await upstashPipeline([["GET", stateKey]]);
  if (res.error) return null;
  return typeof res.result === "string" ? res.result : null;
}

// --- outbox ------------------------------------------------------------------

/** `skipped` = the entry's type switch was off at flush time, so it was
 *  dropped without a post — "stop disabled announcements immediately",
 *  recorded rather than silently vanished so the admin status can show it. */
export type OutboxStatus = "pending" | "sent" | "failed" | "skipped";

export type OutboxEntry = {
  kind: AnnouncementKind;
  payload: unknown;
  at: string;
  n: number;
  status: OutboxStatus;
};

/** The outbox id for one announcement. `seq` comes from the CAS bump (or a
 *  timestamp+counter for ledger-driven kinds), so pause → resume → pause
 *  yields three distinct ids rather than one key overwriting the last. */
export function outboxId(seq: number, kind: string): string {
  return `${Date.now()}-${seq}-${kind}`;
}

/** Appends an entry to the outbox. The payload is the builder's OUTPUT
 *  (a DiscordMessage), so a retry replays exactly what was first composed. */
export async function outboxEnqueue(id: string, kind: AnnouncementKind, payload: unknown): Promise<void> {
  const entry: OutboxEntry = { kind, payload, at: new Date().toISOString(), n: 0, status: "pending" };
  const [res] = await upstashPipeline([["HSET", ANNOUNCE_OUTBOX_KEY, id, JSON.stringify(entry)]]);
  if (res.error) console.error("[announce] outbox enqueue failed:", adminErrorLabel(new Error(res.error)));
}

/** Claims the delivery lease for one id (SET NX PX). `true` = this caller
 *  owns delivery; `false` = another holder (live, or a crashed one whose
 *  lease has not expired yet). */
export async function outboxClaimLease(id: string, leaseMs: number = ANNOUNCE_LEASE_MS): Promise<boolean> {
  const [res] = await upstashPipeline([["SET", `${ANNOUNCE_LEASE_PREFIX}${id}`, "1", "PX", leaseMs, "NX"]]);
  if (res.error) {
    console.error("[announce] outbox lease failed:", adminErrorLabel(new Error(res.error)));
    return false;
  }
  return res.result === "OK";
}

/** Marks an entry sent or failed and releases its lease. */
export async function outboxComplete(id: string, status: OutboxStatus): Promise<void> {
  const [entryRes] = await upstashPipeline([["HGET", ANNOUNCE_OUTBOX_KEY, id]]);
  if (entryRes.error || typeof entryRes.result !== "string") return;
  let entry: OutboxEntry;
  try {
    entry = JSON.parse(entryRes.result) as OutboxEntry;
  } catch {
    return;
  }
  entry.status = status;
  if (status === "failed") entry.n += 1;
  await upstashPipeline([
    ["HSET", ANNOUNCE_OUTBOX_KEY, id, JSON.stringify(entry)],
    ["DEL", `${ANNOUNCE_LEASE_PREFIX}${id}`],
  ]);
}

/** The `pending` entries awaiting a first (or interrupted) delivery attempt.
 *  Any age: the delivery LEASE is the single-winner guard, not an age
 *  heuristic — whoever SET NX PX's it first delivers, everyone else skips. */
export async function outboxPending(): Promise<{ id: string; entry: OutboxEntry }[]> {
  return outboxEntries((e) => e.status === "pending");
}

/** The `failed` entries still worth a retry (attempts remaining), for the
 *  ticker's retry sweep. Ordering oldest-first so a stuck item is retried
 *  before newer ones. */
export async function outboxRetryable(): Promise<{ id: string; entry: OutboxEntry }[]> {
  return outboxEntries((e) => e.status === "failed" && e.n < ANNOUNCE_MAX_ATTEMPTS);
}

async function outboxEntries(
  keep: (entry: OutboxEntry) => boolean,
): Promise<{ id: string; entry: OutboxEntry }[]> {
  try {
    const [res] = await upstashPipeline([["HGETALL", ANNOUNCE_OUTBOX_KEY]]);
    const flat = Array.isArray(res.result) ? (res.result as string[]) : [];
    const out: { id: string; entry: OutboxEntry }[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const id = flat[i];
      const raw = flat[i + 1];
      if (typeof id !== "string" || typeof raw !== "string") continue;
      let entry: OutboxEntry;
      try {
        entry = JSON.parse(raw) as OutboxEntry;
      } catch {
        continue;
      }
      if (keep(entry)) out.push({ id, entry });
    }
    out.sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at));
    return out;
  } catch (err) {
    console.error("[announce] outbox read failed:", adminErrorLabel(err));
    return [];
  }
}

/** Drops entries the sweeps should stop touching: sent ones older than the
 *  retention window, and failed ones that have exhausted their attempts.
 *  Bounded so the hash cannot grow without limit over a long event. */
export async function outboxPrune(retentionMs: number = 24 * 3_600_000, nowMs: number = Date.now()): Promise<void> {
  try {
    const [res] = await upstashPipeline([["HGETALL", ANNOUNCE_OUTBOX_KEY]]);
    const flat = Array.isArray(res.result) ? (res.result as string[]) : [];
    const drop: string[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const id = flat[i];
      const raw = flat[i + 1];
      if (typeof id !== "string" || typeof raw !== "string") continue;
      let entry: OutboxEntry;
      try {
        entry = JSON.parse(raw) as OutboxEntry;
      } catch {
        drop.push(id);
        continue;
      }
      const atMs = Date.parse(entry.at);
      if (!Number.isFinite(atMs)) {
        drop.push(id);
        continue;
      }
      if (entry.status === "sent" && nowMs - atMs > retentionMs) drop.push(id);
      if (entry.status === "skipped") drop.push(id);
      if (entry.status === "failed" && entry.n >= ANNOUNCE_MAX_ATTEMPTS && nowMs - atMs > retentionMs) drop.push(id);
    }
    if (drop.length > 0) await upstashPipeline(drop.map((id) => ["HDEL", ANNOUNCE_OUTBOX_KEY, id]));
  } catch (err) {
    console.error("[announce] outbox prune failed:", adminErrorLabel(err));
  }
}

// --- status ------------------------------------------------------------------

/** The /admin section's status line: how many of each kind have been sent,
 *  and the last success/failure stamps. Counters are advisory (a lost
 *  increment is a cosmetic off-by-one, never a correctness issue), so
 *  failures are logged and swallowed. */
export type AnnounceStatus = {
  posted: Partial<Record<AnnouncementKind, number>>;
  lastPostedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

export async function bumpStatus(kind: AnnouncementKind, outcome: "sent" | "failed", errorText?: string): Promise<void> {
  try {
    const at = new Date().toISOString();
    const cmds: (string | number)[][] = [["HINCRBY", ANNOUNCE_STATUS_KEY, `${kind}:sent`, 1]];
    if (outcome === "sent") {
      cmds.push(["HSET", ANNOUNCE_STATUS_KEY, "lastPostedAt", at]);
    } else if (errorText) {
      cmds.push(["HSET", ANNOUNCE_STATUS_KEY, "lastError", errorText], ["HSET", ANNOUNCE_STATUS_KEY, "lastErrorAt", at]);
    }
    await upstashPipeline(cmds);
  } catch (err) {
    console.error("[announce] status write failed:", adminErrorLabel(err));
  }
}

export async function readStatus(): Promise<AnnounceStatus> {
  try {
    const [res] = await upstashPipeline([["HGETALL", ANNOUNCE_STATUS_KEY]]);
    const flat = Array.isArray(res.result) ? (res.result as string[]) : [];
    const raw: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) {
      if (typeof flat[i] === "string" && typeof flat[i + 1] === "string") raw[flat[i]] = flat[i + 1];
    }
    const posted: Partial<Record<AnnouncementKind, number>> = {};
    for (const kind of ANNOUNCEMENT_KINDS) {
      const n = Number(raw[`${kind}:sent`]);
      if (Number.isFinite(n) && n > 0) posted[kind] = n;
    }
    return {
      posted,
      lastPostedAt: raw.lastPostedAt ?? null,
      lastError: raw.lastError ?? null,
      lastErrorAt: raw.lastErrorAt ?? null,
    };
  } catch (err) {
    console.error("[announce] status read failed:", adminErrorLabel(err));
    return { posted: {}, lastPostedAt: null, lastError: null, lastErrorAt: null };
  }
}
