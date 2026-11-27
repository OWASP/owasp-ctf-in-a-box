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
//   2. STATE — the dedup ledgers, the lifecycle CAS state and the delivery
//      outbox (`ctf:announce:*`). Wiped by the master reset, so a
//      fresh run re-announces its own launches and first bloods.
//   3. CAS — a tiny Lua script that makes "exactly one replica announces
//      this transition" an atomic decision (compare observed pack, swap to
//      next pack, bump the seq id) rather than a read-modify-write race.
//
// Fail directions, deliberately split: every STATE reader here FAILS OPEN
// (an unavailable Redis means no announcement, never a thrown error that
// could take a contestant-facing request down with it), while the CONFIG
// reader THROWS — a config read that fails is a store failure, not an
// "all off" box, and reading it as one would silently disable a configured
// announcer (and back its idle ticker off); every writer reports its failure
// to the caller and logs a label only, never a value, because the values
// here include the webhook URL.

import "server-only";
import { randomUUID } from "node:crypto";
import { upstashPipeline, upstashEval } from "@/lib/upstash";
import { adminErrorLabel, getAdminSettings, writeAdminAudit } from "@/lib/admin-store";
import type { AuditActor } from "@/lib/admin-audit-keys";
import {
  ANNOUNCEMENT_KINDS,
  DISCORD_DEFAULTS,
  checkDiscordWebhookUrl,
  parseMarks,
  zeroKindEpochs,
  type AnnouncementKind,
  type DiscordConfigPatch,
  type DiscordFullConfig,
  type DiscordPublicConfig,
} from "@/lib/discord-config";
import {
  ANNOUNCE_COOLDOWN_KEY,
  ANNOUNCE_LEASE_MS,
  ANNOUNCE_LEASE_PREFIX,
  ANNOUNCE_LIFECYCLE_KEY,
  ANNOUNCE_MAX_ATTEMPTS,
  ANNOUNCE_OUTBOX_KEY,
  ANNOUNCE_RETRY_DELAYS_MS,
  ANNOUNCE_LIFECYCLE_REV_KEY,
  ANNOUNCE_SEQ_KEY,
  ANNOUNCE_STATUS_KEY,
  ANNOUNCE_WEBHOOK_GENERATION_KEY,
  DISCORD_CONFIG_KEY,
  DISCORD_WEBHOOK_KEY,
} from "./keys";
import { decodeLifecycleState, encodeLifecycleState, lifecycleSnapshotFrom } from "./detect";
import { compareOutboxOrder } from "./order";

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

/** The config-hash field holding each kind's switch epoch. It lives in the
 *  config hash, not the outbox, so the disable write can advance it in the
 *  same atomic step that turns the switch off. */
const KIND_EPOCH_FIELDS: Record<AnnouncementKind, string> = {
  "first-blood": "epoch:first-blood",
  launch: "epoch:launch",
  pause: "epoch:pause",
  resume: "epoch:resume",
  milestone: "epoch:milestone",
};

/** The config field holding each kind's on/off switch. Pause and resume are
 *  two edges of the one "scoring paused / resumed" switch. */
const KIND_SWITCH_FIELDS: Record<AnnouncementKind, string> = {
  "first-blood": "firstBlood",
  launch: "launch",
  pause: "pause",
  resume: "pause",
  milestone: "milestones",
};

/** Parses an internal counter. A missing value is 0; a malformed value
 *  THROWS rather than reading as 0, because 0 would let an entry stamped
 *  before a clear or switch disable pass as current. */
function parseCounter(value: unknown, label: string): number {
  if (value === null || value === undefined || value === "") return 0;
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${label}`);
  return n;
}

function parseWebhookGeneration(value: unknown): number {
  return parseCounter(value, "webhook generation");
}

function parseKindEpochs(raw: Record<string, string>): Record<AnnouncementKind, number> {
  const epochs = zeroKindEpochs();
  for (const kind of ANNOUNCEMENT_KINDS) {
    epochs[kind] = parseCounter(raw[KIND_EPOCH_FIELDS[kind]], "switch epoch");
  }
  return epochs;
}

/** Reads the config + generation + webhook in ONE pipeline, then merges the
 *  switches over the defaults. The generation is read BEFORE the URL: a
 *  clear that interleaves between the two then leaves an old generation with
 *  an absent URL (no enqueue) rather than a new generation with the old URL
 *  (an entry a later webhook would accept). An absent hash means all-off —
 *  configuring nothing IS the default state, so the announcer never runs
 *  unasked. A FAILED read THROWS
 *  — both a transport failure and a per-command `{ error }` (a NOAUTH or
 *  WRONGTYPE is a store failure, never a box that chose "all off"; reading
 *  it as one would silently disable a configured announcer and back its
 *  idle ticker off). Callers apply their own fail direction: the ticker
 *  skips the tick and keeps its cadence, the first-blood hook posts
 *  nothing, the flushes deliver nothing, the /admin GET answers 503. The
 *  thrown message carries a LABEL only — never a value; the values here
 *  include the webhook URL. */
export async function getAnnounceConfig(timeoutMs?: number): Promise<DiscordFullConfig> {
  const [cfgRes, genRes, urlRes] = await upstashPipeline(
    [
      ["HGETALL", DISCORD_CONFIG_KEY],
      ["GET", ANNOUNCE_WEBHOOK_GENERATION_KEY],
      ["GET", DISCORD_WEBHOOK_KEY],
    ],
    timeoutMs === undefined ? undefined : { timeoutMs },
  );
  if (cfgRes.error || genRes.error || urlRes.error) {
    // Thrown by LABEL only — never a value; the values here include the
    // webhook URL. Every caller logs (or answers 503) with its own context.
    throw new Error(`announce config read failed: ${cfgRes.error ?? genRes.error ?? urlRes.error}`);
  }
  const flat = Array.isArray(cfgRes.result) ? (cfgRes.result as string[]) : [];
  const raw: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) {
    if (typeof flat[i] === "string" && typeof flat[i + 1] === "string") raw[flat[i]] = flat[i + 1];
  }
  const webhookUrl = typeof urlRes.result === "string" && urlRes.result !== "" ? urlRes.result : null;
  return {
    webhookConfigured: webhookUrl !== null,
    webhookGeneration: parseWebhookGeneration(genRes.result),
    kindEpochs: parseKindEpochs(raw),
    firstBlood: raw.firstBlood === "1",
    launch: raw.launch === "1",
    pause: raw.pause === "1",
    milestones: raw.milestones === "1",
    marks: typeof raw.marks === "string" ? raw.marks : DISCORD_DEFAULTS.marks,
    webhookUrl,
  };
}

/** The client-safe half — the webhook URL is NOT destructured and dropped,
 *  it is never picked up: the return is built field-by-field from the public
 *  shape, so a field that must not leave the server cannot ride along by a
 *  spread or a forgotten omission. `webhookConfigured` is the flag the
 *  /admin section renders instead. */
export function publicConfig(config: DiscordFullConfig): DiscordPublicConfig {
  return {
    webhookConfigured: config.webhookConfigured,
    firstBlood: config.firstBlood,
    launch: config.launch,
    pause: config.pause,
    milestones: config.milestones,
    marks: config.marks,
  };
}

/** Applies a config patch in ONE atomic step: the switch writes, the epoch
 *  bumps of every kind they turn off, and — when the patch takes lifecycle
 *  from off to on — the baseline wipe. A producer can read `firstBlood:
 *  true` and then enqueue after the cancellation scan; the epoch it stamps
 *  is the one it read, and the switch-off moves past it before the producer
 *  can write. Doing the switch write and the bumps in one script also means
 *  no reader can observe the switch ON with the new epoch — which would
 *  stamp a fresh entry from a state that was already disabled.
 *
 *  The off→on check reads the STORED switches, not a config snapshot the
 *  caller took earlier: two saves that both believed lifecycle was off must
 *  not both wipe — the second would delete the baseline the first save's
 *  nudge tick just seeded, and a launch landing in that gap would then be
 *  consumed silently by the next tick's seed. Returns 1 when this write
 *  wiped the baseline, 0 otherwise. */
export const CONFIG_PATCH_SCRIPT = `
local n = tonumber(ARGV[1])
local wasLaunch = redis.call('HGET', KEYS[1], 'launch') == '1'
local wasPause = redis.call('HGET', KEYS[1], 'pause') == '1'
local willLaunch, willPause = wasLaunch, wasPause
local i = 2
for _ = 1, n do
  local f, v = ARGV[i], ARGV[i + 1]
  if f == 'launch' then willLaunch = v == '1'
  elseif f == 'pause' then willPause = v == '1'
  end
  i = i + 2
end
local wiped = 0
if not (wasLaunch or wasPause) and (willLaunch or willPause) then
  redis.call('DEL', KEYS[2])
  wiped = 1
end
i = 2
for _ = 1, n do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
  i = i + 2
end
for j = i, #ARGV do
  redis.call('HINCRBY', KEYS[1], ARGV[j], 1)
end
return wiped
`;

/** Validates a patch field-by-field and writes only the recognised,
 *  validated fields. Unknown keys are refused outright (same contract as
 *  updateAdminSettings), so a typo'd field is an error, not a silent no-op.
 *  Throws with a field-named message on any validation failure; writes
 *  nothing until every field in the patch has passed. Every refusal message
 *  is FIXED — it names the field position and the rule, never the submitted
 *  value or key, so a secret-like marker in a request cannot be echoed back
 *  through an admin-visible error. */
export async function updateAnnounceConfig(actor: AuditActor, patch: DiscordConfigPatch): Promise<DiscordPublicConfig> {
  const boolKeys = ["firstBlood", "launch", "pause", "milestones"] as const;
  const known = new Set<string>([...boolKeys, "marks"]);
  for (const key of Object.keys(patch)) {
    if (!known.has(key)) throw new AnnounceValidationError("unknown announcement setting");
  }

  const writes: [string, string][] = [];
  const changed: Partial<Omit<DiscordFullConfig, "webhookUrl">> = {};
  const disabledKinds: AnnouncementKind[] = [];
  for (const key of boolKeys) {
    if (key in patch) {
      const v = patch[key];
      if (typeof v !== "boolean") throw new AnnounceValidationError(`${key} must be a boolean`);
      writes.push([key, v ? "1" : "0"]);
      changed[key] = v;
      if (!v) {
        if (key === "firstBlood") disabledKinds.push("first-blood");
        else if (key === "launch") disabledKinds.push("launch");
        else if (key === "pause") disabledKinds.push("pause", "resume");
        else disabledKinds.push("milestone");
      }
    }
  }
  if ("marks" in patch) {
    const r = parseMarks(patch.marks);
    if (!r.ok) throw new AnnounceValidationError(r.message);
    const value = typeof patch.marks === "string" ? patch.marks.trim() : "";
    writes.push(["marks", value]);
    changed.marks = value;
  }

  // Turning a stream off cancels what it already retained: a pending or
  // retryable entry left in the outbox would otherwise post when the switch
  // (or the webhook) is enabled again, replaying announcements the organizer
  // opted out of. Do it before the write so a cancellation failure leaves the
  // switch ON and the entries deliverable rather than silently stranded.
  if (disabledKinds.length > 0) await cancelOutboxEntriesFor(disabledKinds);
  if (writes.length > 0) {
    const epochFields = disabledKinds.map((kind) => KIND_EPOCH_FIELDS[kind]);
    await upstashEval(CONFIG_PATCH_SCRIPT, [DISCORD_CONFIG_KEY, ANNOUNCE_LIFECYCLE_KEY], [
      String(writes.length),
      ...writes.flat(),
      ...epochFields,
    ]);
  }
  if (Object.keys(changed).length > 0) {
    // The patch's values are all public prefs — no secret can be in here —
    // so recording them is safe and useful; the webhook URL never is.
    await writeAdminAudit(actor, "announce-config", changed);
  }
  // The response is the fresh read with this patch overlaid: the overlay
  // makes the returned config reflect what the caller just saved even if the
  // read back FAILS (getAnnounceConfig throws on a failed read), so a
  // successful save is never turned into a 503 — the write already landed.
  // The panel takes only the keys this patch wrote, so the fallback's
  // unknown fields are never displayed.
  let current: DiscordFullConfig;
  try {
    current = await getAnnounceConfig();
  } catch (err) {
    console.error("[announce] config read-back failed after save:", adminErrorLabel(err));
    current = {
      ...DISCORD_DEFAULTS,
      webhookConfigured: false,
      webhookUrl: null,
      webhookGeneration: 0,
      kindEpochs: zeroKindEpochs(),
    };
  }
  return publicConfig({ ...current, ...changed });
}

/** Deletes the webhook and advances its generation in one atomic step, so a
 *  producer that read the old config cannot enqueue an entry the new webhook
 *  will later deliver: its entry carries the old generation. */
export const WEBHOOK_CLEAR_SCRIPT = `
local generation = redis.call('INCR', KEYS[2])
redis.call('DEL', KEYS[1])
return generation
`;

/** Stores or clears the webhook URL. `null` clears. The audit trail records
 *  ONLY "set"/"cleared" — never the URL, which is a live credential. */
export async function setAnnounceWebhook(actor: AuditActor, raw: unknown): Promise<{ webhookConfigured: boolean }> {
  if (raw === null) {
    // Clearing the URL must cancel everything already retained, for the same
    // reason a switch-off does: a later set would deliver it to the new URL.
    // Cancel before the atomic clear so a failed cancellation leaves the old
    // webhook in place instead of clearing it with retryable entries queued.
    await cancelOutboxEntriesFor(ANNOUNCEMENT_KINDS);
    await upstashEval(WEBHOOK_CLEAR_SCRIPT, [DISCORD_WEBHOOK_KEY, ANNOUNCE_WEBHOOK_GENERATION_KEY], []);
    await writeAdminAudit(actor, "announce-webhook", { state: "cleared" });
    return { webhookConfigured: false };
  }
  const checked = checkDiscordWebhookUrl(raw);
  if (!checked.ok) throw new AnnounceValidationError(checked.message);
  // A clear freezes the lifecycle pack at its last observed edge, so arming
  // the webhook again must reconcile to the CURRENT state before the URL
  // lands: otherwise a launch (or close) that happened while cleared replays
  // as a fresh edge. Replacing an already-configured webhook must NOT
  // reconcile — the live ticker owns that observation, and silently advancing
  // it here would consume a launch that still needs to be announced.
  const existingUrl = await getWebhookUrl();
  if (existingUrl === null) {
    await reconcileLifecycleState();
  }
  const [res] = await upstashPipeline([["SET", DISCORD_WEBHOOK_KEY, checked.value]]);
  if (res.error) throw new Error(`webhook write failed: ${res.error}`);
  await writeAdminAudit(actor, "announce-webhook", { state: "set" });
  return { webhookConfigured: true };
}

/** The webhook URL, for the sender's use ONLY. Never part of an API
 *  response; callers that need a boolean ask for `webhookConfigured`. A
 *  missing key is a genuine "no webhook" and returns null; a FAILED read
 *  THROWS, because reading a Redis blip as "no webhook" would let senders
 *  clear their queues or skip outbox entries they should retry. */
export async function getWebhookUrl(): Promise<string | null> {
  const [res] = await upstashPipeline([["GET", DISCORD_WEBHOOK_KEY]]);
  if (res.error) throw new Error(`webhook read failed: ${res.error}`);
  return typeof res.result === "string" && res.result !== "" ? res.result : null;
}

/** Reads the webhook URL and its generation in one atomic snapshot. A Lua
 *  EVAL is required, not two GETs in a pipeline: a clear can run between
 *  separate commands (and even between pipelined ones), deleting the URL and
 *  advancing the generation, so both must come from one snapshot. Only a
 *  clear or a master reset advances the generation; replacing a configured
 *  URL is a plain SET and is not fenced here. `false` from a missing key is
 *  normalised to an empty string here so absence is unambiguous; a malformed
 *  stored counter still THROWS through parseWebhookGeneration. */
export const WEBHOOK_TARGET_SCRIPT = `
local url = redis.call('GET', KEYS[1])
local generation = redis.call('GET', KEYS[2])
return {url or '', generation or ''}
`;

/** The webhook URL and the generation it belongs to, read atomically so a
 *  delivery sweep cannot pair the pre-clear URL with the generation a clear
 *  advanced it to. A plain URL replacement keeps the generation, so it is
 *  deliberately not fenced. A failed EVAL THROWS, a missing key is a genuine
 *  "no webhook", and a malformed generation is rejected rather than read as
 *  0 — a sweep must not act on a partial or corrupt view. */
export async function getWebhookDeliveryTarget(): Promise<{ url: string | null; generation: number }> {
  let raw: unknown;
  try {
    raw = await upstashEval(WEBHOOK_TARGET_SCRIPT, [DISCORD_WEBHOOK_KEY, ANNOUNCE_WEBHOOK_GENERATION_KEY], []);
  } catch (err) {
    throw new Error(`webhook target read failed: ${adminErrorLabel(err)}`);
  }
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error("webhook target read failed: malformed reply");
  }
  const rawUrl = raw[0];
  if (rawUrl !== null && rawUrl !== undefined && typeof rawUrl !== "string") {
    throw new Error("webhook target read failed: malformed reply");
  }
  const url = typeof rawUrl === "string" && rawUrl !== "" ? rawUrl : null;
  return { url, generation: parseWebhookGeneration(raw[1]) };
}

// --- dedup ledgers -----------------------------------------------------------

/** Reads one ledger field's stored value, or null when absent/unreadable.
 *  Used by the announcer to find the first solver the award script recorded;
 *  a failed read posts nothing rather than guessing a winner. */
export async function readLedgerField(ledgerKey: string, field: string): Promise<string | null> {
  try {
    const [res] = await upstashPipeline([["HGET", ledgerKey, field]]);
    if (res.error) throw new Error(res.error);
    return typeof res.result === "string" && res.result !== "" ? res.result : null;
  } catch (err) {
    console.error("[announce] ledger read failed:", adminErrorLabel(err));
    return null;
  }
}

/** Claims a set of ledger fields AND writes their outbox entry in one
 *  atomic script. The switch, kind epoch and webhook generation are checked
 *  before any field is claimed, so a disabled/stale producer writes neither
 *  a claim nor an entry; if another replica already owns every field, no
 *  entry is written either. This is what makes "exactly one announcement
 *  per claimable event" survive a crash between claim and enqueue. */
export const CLAIM_LEDGER_AND_ENQUEUE_SCRIPT = `
local n = tonumber(ARGV[1])
local captured = ARGV[2]
if redis.call('HGET', KEYS[3], ARGV[6 + n]) ~= '1' then return 0 end
local currentEpoch = tonumber(redis.call('HGET', KEYS[3], ARGV[7 + n])) or 0
if currentEpoch ~= tonumber(ARGV[8 + n]) then return 0 end
if captured ~= '' then
  local current = redis.call('GET', KEYS[4]) or '0'
  if current ~= captured then return 0 end
end
local at = ARGV[3]
local won = 0
for i = 1, n do
  if redis.call('HSETNX', KEYS[1], ARGV[3 + i], at) == 1 then won = won + 1 end
end
if won == 0 then return 0 end
redis.call('HSET', KEYS[2], ARGV[4 + n], ARGV[5 + n])
return 1
`;

export async function claimLedgerFieldsAndEnqueue(
  ledgerKey: string,
  fields: readonly string[],
  webhookGeneration: number,
  kind: AnnouncementKind,
  kindEpoch: number,
  id: string,
  payload: unknown,
): Promise<boolean> {
  if (fields.length === 0) return false;
  const entry: OutboxEntry = {
    kind,
    payload,
    at: new Date().toISOString(),
    n: 0,
    status: "pending",
    webhookGeneration,
    kindEpoch,
  };
  try {
    const res = await upstashEval(
      CLAIM_LEDGER_AND_ENQUEUE_SCRIPT,
      [ledgerKey, ANNOUNCE_OUTBOX_KEY, DISCORD_CONFIG_KEY, ANNOUNCE_WEBHOOK_GENERATION_KEY],
      [
        String(fields.length),
        String(webhookGeneration),
        entry.at,
        ...fields,
        id,
        JSON.stringify(entry),
        KIND_SWITCH_FIELDS[kind],
        KIND_EPOCH_FIELDS[kind],
        String(kindEpoch),
      ],
    );
    return res === 1;
  } catch (err) {
    console.error("[announce] ledger claim/enqueue failed:", adminErrorLabel(err));
    return false;
  }
}

// --- lifecycle CAS -----------------------------------------------------------

/** The compare-and-swap result: `code` 2 = first observation (the state was
 *  seeded silently, nothing to announce), 1 = the observed transition is
 *  ours to announce, 0 = someone else got there first (or the state has
 *  already moved on since our read), 3 = a webhook save appeared during the
 *  reconcile (reconciliation only) and the live ticker owns the observation.
 *  `prev` is the pack we swapped FROM, so the caller can describe the edge. */
export type StateCasResult = { code: 0 | 1 | 2 | 3; seq: number; prev: string };

/** The CAS script itself, exported for the live-Redis suite, which runs it
 *  against run-unique keys (the store's own stateCompareSet uses the fixed
 *  ctf:announce:* keys, which must not be shared with test runs). */
export const STATE_CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
-- A revision was captured with the expected pack; refuse the swap if the
-- observation moved since, even when a pause/resume cycle brought the pack
-- back to the same string.
if KEYS[3] and ARGV[3] ~= '' then
  local rev = redis.call('GET', KEYS[3]) or '0'
  if rev ~= ARGV[3] then return {0, 0, cur == false and '' or cur} end
end
if cur == false then
  if ARGV[1] == '' then
    local seq = redis.call('INCR', KEYS[2])
    redis.call('SET', KEYS[1], ARGV[2])
    if KEYS[3] then redis.call('INCR', KEYS[3]) end
    return {2, seq, ''}
  end
  return {0, 0, ''}
end
if cur == ARGV[2] then return {0, 0, cur} end
if cur == ARGV[1] then
  local seq = redis.call('INCR', KEYS[2])
  redis.call('SET', KEYS[1], ARGV[2])
  if KEYS[3] then redis.call('INCR', KEYS[3]) end
  return {1, seq, cur}
end
return {0, 0, cur}
`;

/** The reconcile-only CAS: same revision and pack swap as STATE_CAS_SCRIPT,
 *  but refuses to advance the pack when a webhook has appeared since the
 *  caller read it as absent. Code 3 means "leave observation to the ticker",
 *  not a failed swap. */
export const STATE_CAS_RECONCILE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if redis.call('EXISTS', KEYS[4]) == 1 then
  return {3, 0, cur == false and '' or cur}
end
if KEYS[3] and ARGV[3] ~= '' then
  local rev = redis.call('GET', KEYS[3]) or '0'
  if rev ~= ARGV[3] then return {0, 0, cur == false and '' or cur} end
end
if cur == false then
  if ARGV[1] == '' then
    local seq = redis.call('INCR', KEYS[2])
    redis.call('SET', KEYS[1], ARGV[2])
    if KEYS[3] then redis.call('INCR', KEYS[3]) end
    return {2, seq, ''}
  end
  return {0, 0, ''}
end
if cur == ARGV[2] then return {0, 0, cur} end
if cur == ARGV[1] then
  local seq = redis.call('INCR', KEYS[2])
  redis.call('SET', KEYS[1], ARGV[2])
  if KEYS[3] then redis.call('INCR', KEYS[3]) end
  return {1, seq, cur}
end
return {0, 0, cur}
`;

/** An outbox entry to write in the SAME atomic step as a winning lifecycle
 *  CAS. Building it before the CAS is safe: the script only stores entries
 *  when this caller actually won the transition, so a loser leaves no trace. */
export type StateCasEntry = {
  id: string;
  kind: AnnouncementKind;
  payload: unknown;
  webhookGeneration: number;
  kindEpoch: number;
  /** Whether the captured switch was ON. A disabled edge still rides the CAS
   *  (so the observation is fenced against a concurrent enable) but is never
   *  written to the outbox. */
  enabled?: boolean;
};

/** The CAS plus optional outbox writes, one atomic script. Without this, a
 *  replica can win the CAS and crash before enqueueing, consuming the
 *  transition forever; the combined script makes "state advanced" and "the
 *  edge is retained for delivery" one decision. Captured switch, kind epoch
 *  and webhook generation are validated BEFORE the swap, so an observation
 *  that a concurrent disable/clear/re-enable has invalidated neither
 *  advances the pack (which would consume the edge the checks would then
 *  drop) nor writes its entries; the per-entry re-check below is the second
 *  line of the same fence. */
export const STATE_CAS_ENQUEUE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local n = tonumber(ARGV[4])
-- Compare the observation revision captured with the pack: a pause/resume
-- cycle can restore the same pack string, so the pack alone cannot fence a
-- delayed observer. The revision is the trailing ARGV so the entry groups
-- keep their positions.
local expectedRev = ARGV[#ARGV]
if KEYS[6] and expectedRev ~= '' then
  local rev = redis.call('GET', KEYS[6]) or '0'
  if rev ~= expectedRev then return {0, 0, cur == false and '' or cur, 0} end
end
-- A stale observation must not advance the pack. The per-entry checks in
-- the enqueue below would drop the entry AFTER the swap, consuming the
-- edge forever (the next tick sees no change, so the notice is lost while
-- a later resume still fires). Validate the captured switch, epoch and
-- generation BEFORE any write and refuse the whole observation instead:
-- the next tick re-reads fresh counters and wins cleanly.
if n > 0 then
  local i = 5
  for _ = 1, n do
    local switchField = ARGV[i + 2]
    local epochField = ARGV[i + 3]
    local kindEpoch = ARGV[i + 4]
    local generation = ARGV[i + 5]
    local capturedEnabled = ARGV[i + 6]
    i = i + 7
    -- The captured switch state must still match: an enable (or disable)
    -- during the settings read invalidates the observation, including an
    -- entry-free CAS that would otherwise silently consume the edge.
    if (redis.call('HGET', KEYS[4], switchField) or '0') ~= capturedEnabled
      or tonumber(redis.call('HGET', KEYS[4], epochField) or 0) ~= tonumber(kindEpoch)
      or tonumber(redis.call('GET', KEYS[5]) or 0) ~= tonumber(generation) then
      return {0, 0, cur == false and '' or cur, 0}
    end
  end
end
local code
local seq
local prev
if cur == false then
  if ARGV[1] == '' then
    seq = redis.call('INCR', KEYS[2])
    redis.call('SET', KEYS[1], ARGV[2])
    if KEYS[6] then redis.call('INCR', KEYS[6]) end
    code = 2
    prev = ''
  else
    return {0, 0, '', 0}
  end
elseif cur == ARGV[2] then
  return {0, 0, cur, 0}
elseif cur == ARGV[1] then
  seq = redis.call('INCR', KEYS[2])
  redis.call('SET', KEYS[1], ARGV[2])
  if KEYS[6] then redis.call('INCR', KEYS[6]) end
  code = 1
  prev = cur
else
  return {0, 0, cur, 0}
end
local enqueued = 0
if code == 1 and n > 0 then
  local i = 5
  for _ = 1, n do
    local id = ARGV[i]
    local entry = ARGV[i + 1]
    local switchField = ARGV[i + 2]
    local epochField = ARGV[i + 3]
    local kindEpoch = ARGV[i + 4]
    local generation = ARGV[i + 5]
    local capturedEnabled = ARGV[i + 6]
    i = i + 7
    local enabled = redis.call('HGET', KEYS[4], switchField)
    local currentEpoch = tonumber(redis.call('HGET', KEYS[4], epochField)) or 0
    local currentGeneration = tonumber(redis.call('GET', KEYS[5])) or 0
    -- Validation above already matched the captured switch/epoch/generation;
    -- only an ON edge is written to the outbox.
    if capturedEnabled == '1' and enabled == '1' and currentEpoch == tonumber(kindEpoch) and currentGeneration == tonumber(generation) then
      -- Replace the "-1" placeholder with the sequence this CAS just took:
      -- delivery order must follow the committed transition, not a replica's
      -- clock. Plain find/sub, not gsub: "-" is a Lua pattern quantifier.
      local p = string.find(entry, '"seq":-1', 1, true)
      if p then
        entry = string.sub(entry, 1, p - 1) .. '"seq":' .. tostring(seq) .. string.sub(entry, p + 8)
      end
      redis.call('HSET', KEYS[3], id, entry)
      enqueued = enqueued + 1
    end
  end
end
return {code, seq, prev, enqueued}
`;

/** Runs the CAS against the observed lifecycle state. `expected` is the pack
 *  this caller last read ('' when the key is absent); `next` is the pack
 *  derived from the CURRENT observation. Exactly one replica's `next` write
 *  can win per distinct transition, because the swap is atomic and the
 *  loser's `expected` no longer matches. When `entries` is non-empty, the
 *  winning CAS also writes those outbox entries inside the same script, so a
 *  crash cannot advance the state while losing the announcement. The plain
 *  CAS script stays exported as STATE_CAS_SCRIPT for the live-Redis suite. */
export async function stateCompareSet(
  stateKey: typeof ANNOUNCE_LIFECYCLE_KEY,
  expected: string,
  next: string,
  entries: readonly StateCasEntry[] = [],
  expectedRev: number | null = null,
  requireWebhookAbsent = false,
): Promise<StateCasResult> {
  const rev = expectedRev === null ? "" : String(expectedRev);
  if (entries.length === 0) {
    const script = requireWebhookAbsent ? STATE_CAS_RECONCILE_SCRIPT : STATE_CAS_SCRIPT;
    const keys = requireWebhookAbsent
      ? [stateKey, ANNOUNCE_SEQ_KEY, ANNOUNCE_LIFECYCLE_REV_KEY, DISCORD_WEBHOOK_KEY]
      : [stateKey, ANNOUNCE_SEQ_KEY, ANNOUNCE_LIFECYCLE_REV_KEY];
    const raw = await upstashEval(script, keys, [expected, next, rev]);
    return parseCasReply(raw);
  }
  const at = new Date().toISOString();
  const entryArgs = entries.flatMap((entry, index) => {
    const value: OutboxEntry = {
      kind: entry.kind,
      payload: entry.payload,
      at,
      ord: index,
      seq: -1,
      n: 0,
      status: "pending",
      webhookGeneration: entry.webhookGeneration,
      kindEpoch: entry.kindEpoch,
    };
    return [
      entry.id,
      JSON.stringify(value),
      KIND_SWITCH_FIELDS[entry.kind],
      KIND_EPOCH_FIELDS[entry.kind],
      String(entry.kindEpoch),
      String(entry.webhookGeneration),
      entry.enabled === false ? "0" : "1",
    ];
  });
  const raw = await upstashEval(
    STATE_CAS_ENQUEUE_SCRIPT,
    [
      stateKey,
      ANNOUNCE_SEQ_KEY,
      ANNOUNCE_OUTBOX_KEY,
      DISCORD_CONFIG_KEY,
      ANNOUNCE_WEBHOOK_GENERATION_KEY,
      ANNOUNCE_LIFECYCLE_REV_KEY,
    ],
    [expected, next, at, String(entries.length), ...entryArgs, rev],
  );
  return parseCasReply(raw);
}

function parseCasReply(raw: unknown): StateCasResult {
  const arr = Array.isArray(raw) ? (raw as unknown[]) : [];
  const code = Number(arr[0]);
  const seq = Number(arr[1]);
  const prev = typeof arr[2] === "string" ? arr[2] : "";
  return {
    code: (code === 1 || code === 2 || code === 3 ? code : 0) as 0 | 1 | 2 | 3,
    seq: Number.isFinite(seq) ? seq : 0,
    prev,
  };
}

function parseRevision(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** The pack plus the revision it was observed at. Both are read in one
 *  pipeline; a pair that straddles a concurrent write only makes the CAS
 *  lose (a stale revision), never match a newer pack. */
export async function readStatePackWithRev(
  stateKey: typeof ANNOUNCE_LIFECYCLE_KEY,
): Promise<{ pack: string | null; rev: number } | null> {
  try {
    const [pack, rev] = await upstashPipeline([
      ["GET", stateKey],
      ["GET", ANNOUNCE_LIFECYCLE_REV_KEY],
    ]);
    if (pack.error) throw new Error(pack.error);
    if (rev.error) throw new Error(rev.error);
    return {
      pack: typeof pack.result === "string" ? pack.result : null,
      rev: parseRevision(rev.result),
    };
  } catch (err) {
    console.error("[announce] state read failed:", adminErrorLabel(err));
    return null;
  }
}

async function readStatePackStrictWithRev(
  stateKey: typeof ANNOUNCE_LIFECYCLE_KEY,
): Promise<{ pack: string | null; rev: number }> {
  const [pack, rev] = await upstashPipeline([
    ["GET", stateKey],
    ["GET", ANNOUNCE_LIFECYCLE_REV_KEY],
  ]);
  if (pack.error) throw new Error(`state read failed: ${pack.error}`);
  if (rev.error) throw new Error(`state revision read failed: ${rev.error}`);
  return {
    pack: typeof pack.result === "string" ? pack.result : null,
    rev: parseRevision(rev.result),
  };
}

/** Advances the stored observation to the CURRENT event state without
 *  announcing anything. The lifecycle pass only runs while a webhook is
 *  configured, so clearing it freezes the pack at the last observed edge;
 *  arming it again against that stale pack would replay every transition
 *  since (a launch, a close) into the channel. An already-announced pause
 *  bit is carried forward: that hold WAS posted, so the resume it owes must
 *  still announce later. The CAS keeps a racing observer from clobbering a
 *  newer pack: a lost swap re-reads and reconciles against what won. */
async function reconcileLifecycleState(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Read the stored pack BEFORE the settings it will be compared with, and
    // sample the clock per attempt: a slow settings read must not let this
    // pass write a pre-change derivation over a pack a concurrent observer
    // already advanced with newer settings.
    const observed = await readStatePackStrictWithRev(ANNOUNCE_LIFECYCLE_KEY);
    const expected = observed.pack ?? "";
    const prev = decodeLifecycleState(expected);
    const settings = await getAdminSettings();
    const derived = lifecycleSnapshotFrom(
      {
        scoringStartsAt: settings.scoringStartsAt,
        scoringEndsAt: settings.scoringEndsAt,
        paused: settings.paused,
      },
      Date.now(),
    );
    const next = encodeLifecycleState({ ...derived, announced: Boolean(prev?.announced) });
    if (expected === next) return;
    const cas = await stateCompareSet(ANNOUNCE_LIFECYCLE_KEY, expected, next, [], observed.rev, true);
    // 3 = another save configured the webhook while this one was reconciling;
    // the live ticker owns the observation from here.
    if (cas.code === 3) return;
    // 1 = our silent write won, 2 = seeded from no previous state. 0 = a
    // racing writer moved the pack; re-read it and reconcile again.
    if (cas.code !== 0) return;
  }
  // A pack that keeps moving (or an unreadable one) must fail the webhook
  // write: arming the URL while the observation is unreconciled would let the
  // next tick announce the old pack's transitions as fresh edges.
  throw new Error("lifecycle state reconcile did not converge");
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
  /** Position within a multi-entry lifecycle CAS, which stamps every entry
   *  with one `at`. Absent (`0`) on standalone enqueues. */
  ord?: number;
  /** The outbox order counter the write stamped (`ANNOUNCE_SEQ_KEY`,
   *  INCR'd inside the same script as the entry). Lifecycle edges from
   *  different replicas carry the Redis sequence, not their writers' clocks,
   *  so a pause cannot sort after the resume that follows it just because
   *  one replica's clock ran ahead. `-1` is the pre-write placeholder the
   *  Lua scripts replace with the counter they just took. Absent on entries
   *  written before this field existed — they fall back to `at` ordering. */
  seq?: number;
  n: number;
  status: OutboxStatus;
  /** Epoch ms of the last failed attempt, so the retry sweep can wait out
   *  ANNOUNCE_RETRY_DELAYS_MS. Absent on entries that never failed, and on
   *  ones written before it existed, which are due at once. */
  triedAt?: number;
  webhookGeneration: number;
  kindEpoch: number;
};

let outboxCounter = 0;

/** A collision-resistant outbox id for producers that must build the entry
 *  BEFORE the atomic write (the lifecycle CAS, whose seq is only known after
 *  the script runs). Time + in-process counter + random entropy + kind keeps
 *  replicas and same-millisecond bursts from overwriting each other. */
export function newOutboxId(kind: string): string {
  outboxCounter += 1;
  return `${Date.now()}-${outboxCounter}-${randomUUID().slice(0, 8)}-${kind}`;
}

/** Atomically claims the delivery lease for an outbox entry iff its status
 *  and retry count still match what the caller observed, its switch is still
 *  on, its kind epoch still matches the stored one, AND its webhook
 *  generation is still current. Prevents duplicate delivery when another
 *  replica completed the entry and deleted its lease between our candidate
 *  read and our lease attempt, and prevents an entry from a disabled,
 *  since-re-enabled, or pre-clear stream from acquiring a lease at all. */
export const OUTBOX_CLAIM_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local ok, e = pcall(cjson.decode, raw)
if not ok or type(e) ~= 'table' then return 0 end
if e.status ~= ARGV[2] or tonumber(e.n) ~= tonumber(ARGV[3]) then return 0 end
if redis.call('HGET', KEYS[3], ARGV[6]) ~= '1' then return 0 end
local currentEpoch = tonumber(redis.call('HGET', KEYS[3], ARGV[7])) or 0
if tonumber(e.kindEpoch) ~= currentEpoch then return 0 end
local currentGeneration = tonumber(redis.call('GET', KEYS[4])) or 0
if tonumber(e.webhookGeneration) ~= currentGeneration then return 0 end
-- Lifecycle edges stay in stream order across replicas: a later launch/pause/
-- resume must not overtake an earlier one that is still pending or retryable.
-- Compare (seq, ord) — the committed order, the same order
-- deliveryCandidates uses — falling back to (at, ord) for entries written
-- before seq existed; sent/skipped are delivered/cancelled, and a failed
-- entry past its retry budget no longer blocks.
local kind = e.kind
if kind == 'launch' or kind == 'pause' or kind == 'resume' then
  local flat = redis.call('HGETALL', KEYS[1])
  for j = 1, #flat, 2 do
    local otherId = flat[j]
    if otherId ~= ARGV[1] then
      local ok2, o = pcall(cjson.decode, flat[j + 1])
      if ok2 and type(o) == 'table' and (o.kind == 'launch' or o.kind == 'pause' or o.kind == 'resume') then
        local earlier, current = false, false
        local os, es = tonumber(o.seq), tonumber(e.seq)
        if os ~= nil and es ~= nil then
          if os < es then earlier = true
          elseif os > es then current = true
          elseif (tonumber(o.ord) or 0) < (tonumber(e.ord) or 0) then earlier = true
          else current = true
          end
        else
          local earlierAt = tostring(o.at or '')
          local currentAt = tostring(e.at or '')
          local earlierOrd = tonumber(o.ord) or 0
          local currentOrd = tonumber(e.ord) or 0
          if earlierAt < currentAt or (earlierAt == currentAt and earlierOrd < currentOrd) then earlier = true
          elseif currentAt < earlierAt or (currentAt == earlierAt and currentOrd < earlierOrd) then current = true
          end
        end
        if earlier and not current then
          local exhausted = o.status == 'failed' and (tonumber(o.n) or 0) >= tonumber(ARGV[8])
          if o.status ~= 'sent' and o.status ~= 'skipped' and not exhausted then return 0 end
        end
      end
    end
  end
end
if redis.call('SET', KEYS[2], ARGV[5], 'PX', ARGV[4], 'NX') then return 1 end
return 0
`;

/** Claims the delivery lease for one outbox entry iff its status and retry
 *  count still match `seen`, its switch is on, and its kind epoch is current.
 *  Returns an owner token on success, null when the entry was already
 *  completed, moved to another retry state, is currently leased by another
 *  worker, or belongs to a disabled/stale stream. The token goes into the
 *  lease value so completion can prove it still owns the lease. A command
 *  error or rejected Redis call ALSO returns null: nothing is claimed, the
 *  entry stays `pending` or `failed` for the next flush or retry sweep, and
 *  delivery fails closed rather than risking a double post. */
export async function outboxClaim(
  id: string,
  seen: Pick<OutboxEntry, "status" | "n" | "kind">,
  leaseMs: number = ANNOUNCE_LEASE_MS,
): Promise<string | null> {
  const token = randomUUID();
  try {
    const [res] = await upstashPipeline([
      [
        "EVAL",
        OUTBOX_CLAIM_SCRIPT,
        4,
        ANNOUNCE_OUTBOX_KEY,
        `${ANNOUNCE_LEASE_PREFIX}${id}`,
        DISCORD_CONFIG_KEY,
        ANNOUNCE_WEBHOOK_GENERATION_KEY,
        id,
        seen.status,
        seen.n,
        leaseMs,
        token,
        KIND_SWITCH_FIELDS[seen.kind],
        KIND_EPOCH_FIELDS[seen.kind],
        ANNOUNCE_MAX_ATTEMPTS,
      ],
    ]);
    if (res.error) {
      console.error("[announce] outbox claim failed:", adminErrorLabel(new Error(res.error)));
      return null;
    }
    return res.result === 1 ? token : null;
  } catch (err) {
    console.error("[announce] outbox claim failed:", adminErrorLabel(err));
    return null;
  }
}

/** Writes an entry's terminal status and releases its lease, but ONLY if the
 *  caller still owns that lease. A worker that outlived its 90s lease must not
 *  overwrite the result a newer owner recorded, nor delete the newer owner's
 *  live lease. When this completion is the entry's last failed attempt
 *  (ARGV[4] '1'), the status hash's `dropped` count goes up in the same
 *  script: a drop is counted once, exactly when the exhausted entry is
 *  stored, never for a completion that did not land.
 *  KEYS: [1] outbox, [2] lease, [3] ctf:announce:status. */
export const OUTBOX_COMPLETE_SCRIPT = `
local lease = redis.call('GET', KEYS[2])
if not lease or lease ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
redis.call('DEL', KEYS[2])
if ARGV[4] == '1' and KEYS[3] then redis.call('HINCRBY', KEYS[3], 'dropped', 1) end
return 1
`;

/** Cancels an entry nobody will deliver: pending, or failed with attempts
 *  remaining, becomes skipped. A conditional write, so it cannot overwrite a
 *  terminal sent/skipped result, and it drops the lease so a stalled worker's
 *  later completion fails its token check instead of resurrecting the entry. */
export const OUTBOX_SKIP_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local ok, e = pcall(cjson.decode, raw)
if not ok or type(e) ~= 'table' then return 0 end
if e.status ~= 'pending' and e.status ~= 'failed' then return 0 end
e.status = 'skipped'
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(e))
redis.call('DEL', KEYS[2])
return 1
`;

/** Marks an entry sent or failed and releases its lease — only while the
 *  caller's claim token still owns that lease. A stale owner returns without
 *  touching the status or the newer owner's lease. */
export async function outboxComplete(id: string, status: OutboxStatus, token: string): Promise<void> {
  try {
    const [entryRes] = await upstashPipeline([["HGET", ANNOUNCE_OUTBOX_KEY, id]]);
    if (entryRes.error) {
      console.error("[announce] outbox read failed:", adminErrorLabel(new Error(entryRes.error)));
      return;
    }
    if (typeof entryRes.result !== "string") return;
    let entry: OutboxEntry;
    try {
      entry = JSON.parse(entryRes.result) as OutboxEntry;
    } catch {
      return;
    }
    entry.status = status;
    if (status === "failed") {
      entry.n += 1;
      entry.triedAt = Date.now();
    }
    const exhausted = status === "failed" && entry.n >= ANNOUNCE_MAX_ATTEMPTS;
    const [res] = await upstashPipeline([
      [
        "EVAL",
        OUTBOX_COMPLETE_SCRIPT,
        3,
        ANNOUNCE_OUTBOX_KEY,
        `${ANNOUNCE_LEASE_PREFIX}${id}`,
        ANNOUNCE_STATUS_KEY,
        token,
        id,
        JSON.stringify(entry),
        exhausted ? "1" : "0",
      ],
    ]);
    if (res.error) console.error("[announce] outbox complete failed:", adminErrorLabel(new Error(res.error)));
  } catch (err) {
    console.error("[announce] outbox complete failed:", adminErrorLabel(err));
  }
}

/** Releases a lease without changing the entry's status or attempt count.
 *  Used for a 429: the batch was never attempted for retry-budget purposes,
 *  so the entries must stay claimable when Discord says to resume. The
 *  token check keeps a stale owner from deleting a newer owner's lease. */
export const OUTBOX_RELEASE_SCRIPT = `
local lease = redis.call('GET', KEYS[2])
if not lease or lease ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[2])
return 1
`;

export async function outboxRelease(id: string, token: string): Promise<void> {
  try {
    const [res] = await upstashPipeline([
      ["EVAL", OUTBOX_RELEASE_SCRIPT, 2, ANNOUNCE_OUTBOX_KEY, `${ANNOUNCE_LEASE_PREFIX}${id}`, token],
    ]);
    if (res.error) console.error("[announce] outbox release failed:", adminErrorLabel(new Error(res.error)));
  } catch (err) {
    console.error("[announce] outbox release failed:", adminErrorLabel(err));
  }
}

/** The remaining Discord cooldown in ms. 0 means "post now"; a failed read
 *  also returns 0 (fail open — a Redis blip must not silently pause posts). */
export async function announceCooldownMs(): Promise<number> {
  try {
    const [res] = await upstashPipeline([["GET", ANNOUNCE_COOLDOWN_KEY]]);
    if (res.error) throw new Error(res.error);
    const at = Number(res.result);
    if (!Number.isFinite(at)) return 0;
    return Math.max(0, at - Date.now());
  } catch (err) {
    console.error("[announce] cooldown read failed:", adminErrorLabel(err));
    return 0;
  }
}

/** Keeps max(stored, proposed): replicas race their own 429s, and a shorter
 *  deadline arriving last must not shorten a longer one already parked —
 *  delivery would resume before the stricter restriction ends. */
export const SET_ANNOUNCE_COOLDOWN_SCRIPT = `
local now = tonumber(ARGV[2])
local proposed = tonumber(ARGV[1])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local untilMs = math.max(cur, proposed)
redis.call('SET', KEYS[1], tostring(untilMs), 'PX', math.max(1, untilMs - now))
return untilMs
`;

/** Starts a Discord cooldown. A 429 is the one refusal that must not burn an
 *  entry's retry budget: the sweeps check this before claiming anything, so
 *  the batch stays pending and the attempt count is unchanged. The write is
 *  max() semantics in Lua, so concurrent 429s keep the latest deadline. */
export async function setAnnounceCooldown(ms: number): Promise<void> {
  const now = Date.now();
  const until = now + Math.max(1_000, Math.ceil(ms));
  try {
    await upstashEval(SET_ANNOUNCE_COOLDOWN_SCRIPT, [ANNOUNCE_COOLDOWN_KEY], [String(until), String(now)]);
  } catch (err) {
    console.error("[announce] cooldown write failed:", adminErrorLabel(err));
  }
}

/** Cancels an unclaimed entry (switch off, webhook cleared, local queue
 *  overflow) as skipped. The script is conditional on a non-terminal status,
 *  so it cannot overwrite a delivery another worker already recorded. */
export async function outboxSkip(id: string): Promise<void> {
  try {
    const [res] = await upstashPipeline([
      ["EVAL", OUTBOX_SKIP_SCRIPT, 2, ANNOUNCE_OUTBOX_KEY, `${ANNOUNCE_LEASE_PREFIX}${id}`, id],
    ]);
    if (res.error) console.error("[announce] outbox skip failed:", adminErrorLabel(new Error(res.error)));
  } catch (err) {
    console.error("[announce] outbox skip failed:", adminErrorLabel(err));
  }
}

/** The `pending` entries awaiting a first (or interrupted) delivery attempt.
 *  Any age: the delivery LEASE is the single-winner guard, not an age
 *  heuristic — whoever SET NX PX's it first delivers, everyone else skips. */
export async function outboxPending(): Promise<{ id: string; entry: OutboxEntry }[]> {
  return outboxEntries((e) => e.status === "pending");
}

/** Whether a failed entry is due for another attempt: attempts remain and
 *  its backoff (ANNOUNCE_RETRY_DELAYS_MS) has passed since the last one. */
export function retryDue(entry: Pick<OutboxEntry, "status" | "n" | "triedAt">, nowMs: number): boolean {
  if (entry.status !== "failed" || entry.n >= ANNOUNCE_MAX_ATTEMPTS) return false;
  if (typeof entry.triedAt !== "number") return true;
  const delay = ANNOUNCE_RETRY_DELAYS_MS[Math.min(Math.max(entry.n, 1), ANNOUNCE_RETRY_DELAYS_MS.length) - 1];
  return nowMs - entry.triedAt >= delay;
}

/** The `failed` entries due for a retry (attempts remaining, backoff passed),
 *  for the ticker's retry sweep. Ordering oldest-first so a stuck item is
 *  retried before newer ones. One not yet due still holds back a later
 *  lifecycle edge (OUTBOX_CLAIM_SCRIPT), so the stream stays in order. This
 *  is a snapshot: the claim re-checks the entry's status and attempt count
 *  against it, so a sweep whose selection another worker has since retried
 *  (a newer `n` and `triedAt`) claims nothing and cannot post before the
 *  next delay. */
export async function outboxRetryable(nowMs: number = Date.now()): Promise<{ id: string; entry: OutboxEntry }[]> {
  return outboxEntries((e) => retryDue(e, nowMs));
}

/** Parses the outbox hash entries `keep` accepts, oldest first. An
 *  unparsable entry is skipped, never delivered; a Redis failure THROWS so
 *  callers that must not act on a partial view (cancellation) can fail
 *  closed. */
async function parseOutboxEntries(
  keep: (entry: OutboxEntry) => boolean,
): Promise<{ id: string; entry: OutboxEntry }[]> {
  const [res] = await upstashPipeline([["HGETALL", ANNOUNCE_OUTBOX_KEY]]);
  if (res.error) throw new Error(`outbox read failed: ${res.error}`);
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
  out.sort(compareOutboxOrder);
  return out;
}

/** The outbox entries `keep` accepts, failing open to nothing on a Redis
 *  failure — the sweep readers' contract. */
async function outboxEntries(
  keep: (entry: OutboxEntry) => boolean,
): Promise<{ id: string; entry: OutboxEntry }[]> {
  try {
    return await parseOutboxEntries(keep);
  } catch (err) {
    console.error("[announce] outbox read failed:", adminErrorLabel(err));
    return [];
  }
}

/** Cancels outstanding deliveries for `kinds`: pending entries and failed
 *  ones with attempts remaining become skipped. A failed read or cancel
 *  THROWS so the config/webhook write that triggered this does not land with
 *  retained entries that a later enable would replay. */
async function cancelOutboxEntriesFor(kinds: readonly AnnouncementKind[]): Promise<void> {
  const wanted = new Set(kinds);
  const entries = await parseOutboxEntries(
    (e) =>
      wanted.has(e.kind) &&
      (e.status === "pending" || (e.status === "failed" && e.n < ANNOUNCE_MAX_ATTEMPTS)),
  );
  if (entries.length === 0) return;
  const results = await upstashPipeline(
    entries.map(({ id }) => [
      "EVAL",
      OUTBOX_SKIP_SCRIPT,
      2,
      ANNOUNCE_OUTBOX_KEY,
      `${ANNOUNCE_LEASE_PREFIX}${id}`,
      id,
    ]),
  );
  for (const res of results) {
    if (res.error) throw new Error(`outbox cancel failed: ${res.error}`);
  }
}

/** Drops entries the sweeps should stop touching: sent ones older than the
 *  retention window, and failed ones that have exhausted their attempts.
 *  Bounded so the hash cannot grow without limit over a long event. */
export async function outboxPrune(retentionMs: number = 24 * 3_600_000, nowMs: number = Date.now()): Promise<void> {
  try {
    const [res] = await upstashPipeline([["HGETALL", ANNOUNCE_OUTBOX_KEY]]);
    if (res.error) throw new Error(res.error);
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
    if (drop.length > 0) {
      const results = await upstashPipeline(drop.map((id) => ["HDEL", ANNOUNCE_OUTBOX_KEY, id]));
      for (const res of results) {
        if (res.error) throw new Error(res.error);
      }
    }
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
  /** Announcements that ran out of attempts since the last successful post:
   *  lost, which the card says, cleared by the next post that lands. */
  dropped: number;
  /** Announcements still to be delivered: pending, or failed with attempts
   *  left. With a failure newer than the last post, the card reads it as
   *  "N pending" behind a failing webhook. Null when the outbox could not be
   *  read, which is not the same as nothing waiting. */
  pending: number | null;
};

/** Records one delivery outcome: a successful post bumps that kind's `sent`
 *  counter and the last-posted stamp and resets `dropped`; a failed one
 *  records the error text and its time and bumps no `sent` counter (that is
 *  what the admin status line reads as "posted"). A drop is counted by the
 *  completion that stores the exhausted entry (OUTBOX_COMPLETE_SCRIPT), not
 *  here. */
export async function bumpStatus(kind: AnnouncementKind, outcome: "sent" | "failed", errorText?: string): Promise<void> {
  try {
    const at = new Date().toISOString();
    // The sent counter counts SUCCESSFUL posts only: a failed post that
    // bumped it would make the admin status line report deliveries that
    // never reached Discord.
    const cmds: (string | number)[][] = [];
    if (outcome === "sent") {
      cmds.push(["HINCRBY", ANNOUNCE_STATUS_KEY, `${kind}:sent`, 1]);
      cmds.push(["HSET", ANNOUNCE_STATUS_KEY, "lastPostedAt", at]);
      cmds.push(["HSET", ANNOUNCE_STATUS_KEY, "dropped", 0]);
    } else {
      if (errorText) {
        cmds.push(["HSET", ANNOUNCE_STATUS_KEY, "lastError", errorText], ["HSET", ANNOUNCE_STATUS_KEY, "lastErrorAt", at]);
      }
    }
    if (cmds.length > 0) {
      const results = await upstashPipeline(cmds);
      for (const res of results) {
        if (res.error) throw new Error(res.error);
      }
    }
  } catch (err) {
    console.error("[announce] status write failed:", adminErrorLabel(err));
  }
}

/** The status counters and stamps, as the admin section reads them. A
 *  missing or unreadable hash reads as "nothing posted yet", never an
 *  error. */
export async function readStatus(): Promise<AnnounceStatus> {
  try {
    const [res] = await upstashPipeline([["HGETALL", ANNOUNCE_STATUS_KEY]]);
    if (res.error) throw new Error(res.error);
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
    let pending: number | null = null;
    try {
      pending = (
        await parseOutboxEntries((e) => e.status === "pending" || (e.status === "failed" && e.n < ANNOUNCE_MAX_ATTEMPTS))
      ).length;
    } catch (err) {
      console.error("[announce] outbox read failed:", adminErrorLabel(err));
    }
    return {
      posted,
      lastPostedAt: raw.lastPostedAt ?? null,
      lastError: raw.lastError ?? null,
      lastErrorAt: raw.lastErrorAt ?? null,
      dropped: Math.max(0, Number(raw.dropped) || 0),
      pending,
    };
  } catch (err) {
    console.error("[announce] status read failed:", adminErrorLabel(err));
    return { posted: {}, lastPostedAt: null, lastError: null, lastErrorAt: null, dropped: 0, pending: null };
  }
}
