// Redis keys for the Discord announcements (#590). Two families, split by
// lifetime:
//
//   - `ctf:admin:discord*` — organizer CONFIGURATION (the webhook URL and
//     the per-type switches/options). Kept by the master reset, exactly like
//     `ctf:admin:settings`, because it is something the organizer SET, not
//     event data. The webhook URL lives in its OWN key (`:webhook`) so the
//     config hash can be read into an API response without the secret ever
//     being in the same object.
//
//   - `ctf:announce:*` — runtime announcement STATE (dedup ledgers, the
//     delivery outbox, the lifecycle/board observations, status counters).
//     Wiped by the master reset (`RESET_PREFIXES` in admin-store.ts) so a
//     fresh run re-announces its own launches and first bloods, while the
//     organizer's webhook setup survives.

/** The non-secret config hash: one field per switch/option (see
 *  announce/store.ts for the field names). Absent field = default = off. */
export const DISCORD_CONFIG_KEY = "ctf:admin:discord";

/** The webhook URL, alone. NEVER returned to a client, never logged, never
 *  audited by value — writeAdminAudit records only "set"/"cleared". */
export const DISCORD_WEBHOOK_KEY = "ctf:admin:discord:webhook";

// --- announcement state (all wiped by the master reset) ---------------------

/** Per-challenge first-blood claims: field `<module>:<challengeId>` → JSON
 *  `{login, at}`. HSETNX makes "the first solve" a single atomic decision
 *  across replicas and retries. */
export const ANNOUNCE_FIRST_KEY = "ctf:announce:first";

/** Per-challenge release claims: field `<module>:<challengeId>` → the ISO
 *  instant the challenge first became publicly visible to the announcer.
 *  Claimed even while announcements are off, so enabling later never
 *  replays challenges that were already public. */
export const ANNOUNCE_RELEASED_KEY = "ctf:announce:released";

/** Daily-summary claims: field `YYYY-MM-DD` (the event-local calendar day)
 *  → the ISO instant the claim was made. One post per event-local day. */
export const ANNOUNCE_DAILY_KEY = "ctf:announce:daily";

/** The totals snapshot the daily summary diffs against: JSON
 *  `{solves, released, at}` as of the last daily fire (or the seed).
 *  Updated ONLY when a daily claims, so the delta is "since the last
 *  summary", not "since the last tick". A missing snapshot (first fire
 *  after enabling) seeds the baseline and reports zeros — an understated
 *  first summary beats an overstated one (ADR 69). */
export const ANNOUNCE_DAILY_SNAPSHOT_KEY = "ctf:announce:daily:snapshot";

/** Remaining-time-mark claims: field `<endsAtMs>:<markMs>` → ISO instant.
 *  Keyed by the scoring-close instant, so moving Scoring closes re-arms the
 *  marks for the new window rather than inheriting the old one's claims. */
export const ANNOUNCE_MILESTONE_KEY = "ctf:announce:milestone";

/** The observed lifecycle state (`v1|L0|P0|R1`), advanced atomically by
 *  ANNOUNCE_STATE_SCRIPT so exactly one replica announces each transition. */
export const ANNOUNCE_LIFECYCLE_KEY = "ctf:announce:lifecycle";

/** The observed top-of-board snapshot, same CAS discipline as the
 *  lifecycle state. */
export const ANNOUNCE_BOARD_KEY = "ctf:announce:board";

/** Monotonic id source bumped inside ANNOUNCE_STATE_SCRIPT, so every
 *  announced transition/outbox entry gets a unique id even when the same
 *  edge repeats (pause → resume → pause). */
export const ANNOUNCE_SEQ_KEY = "ctf:announce:seq";

/** The delivery outbox: field = announcement id, value = JSON
 *  `{kind, payload, at, n, status}`. `status` is `pending` (queued here or
 *  on another replica, guarded by its lease key), `sent`, or `failed`
 *  (retryable until `n` reaches ANNOUNCE_MAX_ATTEMPTS). */
export const ANNOUNCE_OUTBOX_KEY = "ctf:announce:outbox";

/** Per-id delivery lease: `ctf:announce:lease:<id>` SET NX PX, the single
 *  cross-replica guard on "who delivers this". A crashed owner's lease
 *  expires and the next retry sweep may re-claim. */
export const ANNOUNCE_LEASE_PREFIX = "ctf:announce:lease:";
export const announceLeaseKey = (id: string) => `${ANNOUNCE_LEASE_PREFIX}${id}`;

/** Delivery lease / retry backoff: long enough to cover the coalesce window
 *  plus a full send with timeout, short enough that a crashed owner's item
 *  is retried within a tick or two. */
export const ANNOUNCE_LEASE_MS = 90_000;

/** Attempt cap per announcement; beyond it the outbox entry stays `failed`
 *  and the sweeps stop touching it. */
export const ANNOUNCE_MAX_ATTEMPTS = 3;

/** Status counters + last post/failure, for the /admin section. */
export const ANNOUNCE_STATUS_KEY = "ctf:announce:status";
