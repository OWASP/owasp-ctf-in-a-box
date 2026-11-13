// Discord delivery for the announcer (#590). `server-only`: holds the
// webhook URL in flight.
//
// The transport is the Redis outbox, not a fire-and-forget fetch:
//
//   enqueue  → outbox entry (`pending`) + a coalescing flush timer
//   flush    → lease each entry (SET NX PX), pack up to 10 embeds into ONE
//              POST, mark the leased entries sent/failed together
//   ticker   → the retry sweep re-delivers `failed` entries (attempts
//              remaining), same lease discipline
//
// Which means: a restart between enqueue and POST loses nothing durable, a
// crashed flusher's entry is retried when its lease expires, and two
// replicas cannot both deliver the same entry (whoever wins the lease
// delivers). Delivery is AT-LEAST-ONCE — a POST that succeeds but whose
// `sent` write is lost will be retried — which is the right direction for
// announcements (a rare duplicate beats a silent drop) and is recorded as
// such in ADR 70.
//
// The kind switch is checked at BOTH ends: at enqueue (the common case — a
// tick that would generate a disabled kind never writes an entry) and at
// flush ("stop disabled announcements immediately": an organizer who turns a
// switch off between enqueue and flush does not get that post). Never logging
// the URL or the payload is absolute — errors go through errorLabel only.

import "server-only";
import { errorLabel } from "@/lib/error-label";
import { kindEnabled, type AnnouncementKind } from "@/lib/discord-config";
import type { DiscordMessage } from "./messages";
import {
  announceCooldownMs,
  bumpStatus,
  claimLedgerFieldsAndEnqueue,
  getAnnounceConfig,
  getWebhookDeliveryTarget,
  newOutboxId,
  outboxClaim,
  outboxComplete,
  outboxEnqueue,
  outboxPending,
  outboxPrune,
  outboxRelease,
  outboxRetryable,
  outboxSkip,
  setAnnounceCooldown,
  type OutboxEntry,
} from "./store";

/** At most this many embeds in one POST — Discord's documented batch limit
 *  is 10; exceeding it fails the whole request. */
const PACK_EMBEDS = 10;

/** One POST's timeout. A hung Discord endpoint must not pin a flush open. */
const SEND_TIMEOUT_MS = 5_000;

/** Coalesce window: announcements that land within it (a burst of solves,
 *  a lifecycle edge plus its first blood) leave in one flush pass. */
const FLUSH_COALESCE_MS = 250;

/** In-process bound on how many not-yet-flushed entries THIS replica may
 *  hold. Older entries are dropped (counted) rather than growing the queue
 *  without limit — a Discord outage must not become a memory leak. */
const MAX_QUEUE = 100;

let queue: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let droppedCount = 0;

/** How many enqueues were dropped by the bound. Admin-facing cosmetic. */
export function droppedEnqueues(): number {
  return droppedCount;
}

/** Enqueues one announcement, if its switch is on and a webhook is
 *  configured. A disabled kind or an unconfigured box is a NO-OP (no entry,
 *  no timer) — the announcer never accumulates work it will not send.
 *
 *  `captured` carries the generation and switch epoch a producer read BEFORE
 *  its asynchronous lookups. When given, those exact counters are stamped
 *  and the store rejects the write atomically if the stream was disabled,
 *  re-enabled or the webhook rotated meanwhile — a late notification never
 *  borrows a fresh counter it did not observe. */
export async function enqueueAnnouncement(
  kind: AnnouncementKind,
  message: DiscordMessage,
  captured?: { webhookGeneration: number; kindEpoch: number },
): Promise<void> {
  let webhookGeneration: number;
  let kindEpoch: number;
  if (captured) {
    webhookGeneration = captured.webhookGeneration;
    kindEpoch = captured.kindEpoch;
  } else {
    const config = await getAnnounceConfig();
    if (!config.webhookConfigured || !kindEnabled(config, kind)) return;
    webhookGeneration = config.webhookGeneration;
    kindEpoch = config.kindEpochs[kind];
  }
  const id = newOutboxId(kind);
  if (!(await outboxEnqueue(id, kind, message, webhookGeneration, kindEpoch))) return;
  await trackEnqueued(id);
}

/** Enqueues a ledger-driven announcement and claims its ledger fields in ONE
 *  atomic script. The switch/epoch/generation checks live inside that script,
 *  so a rejected claim writes neither a claim nor an entry. Used for first
 *  blood and remaining-time marks, where the claim itself is the dedup. */
export async function enqueueLedgerAnnouncement(
  kind: AnnouncementKind,
  message: DiscordMessage,
  ledgerKey: string,
  fields: readonly string[],
  captured: { webhookGeneration: number; kindEpoch: number },
): Promise<boolean> {
  const id = newOutboxId(kind);
  const written = await claimLedgerFieldsAndEnqueue(
    ledgerKey,
    fields,
    captured.webhookGeneration,
    kind,
    captured.kindEpoch,
    id,
    message,
  );
  if (!written) return false;
  await trackEnqueued(id);
  return true;
}

/** Bounds and flushes a freshly written entry. Shared by both enqueue paths
 *  so the drop policy and coalescing timer cannot drift apart. */
async function trackEnqueued(id: string): Promise<void> {
  queue.push(id);
  while (queue.length > MAX_QUEUE) {
    const droppedId = queue.shift();
    droppedCount += 1;
    if (droppedId) await outboxSkip(droppedId);
  }
  scheduleFlush();
}

/** Arms the coalescing flush (one per replica; unref'd so it cannot hold a
 *  serverless instance open). */
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_COALESCE_MS);
  // Node's timer: unref keeps a pending announcement from pinning the process.
  flushTimer.unref?.();
}

/** One flush pass: lease everything currently `pending`, pack it, post it.
 *  Re-entrant-safe (the timer and a direct call cannot interleave); a second
 *  call during a pass returns immediately — after re-arming the coalescing
 *  timer, so an entry enqueued mid-pass (or during the ticker's retry pass,
 *  which shares this guard) is flushed by a later pass instead of waiting
 *  for some future enqueue to happen along. */
export async function flush(): Promise<void> {
  if (flushing) {
    scheduleFlush();
    return;
  }
  flushing = true;
  try {
    // A 429 parks every entry untouched (no attempt spent, no status change)
    // until Discord's retry instant. Both sweeps share this gate so a retry
    // sweep cannot slip past the cooldown the fresh flush just recorded.
    if ((await announceCooldownMs()) > 0) return;
    queue = queue.filter((id) => id !== ""); // defensive; ids are never ""
    const config = await getAnnounceConfig();
    if (!config.webhookConfigured) {
      queue = [];
      return;
    }
    let url: string | null;
    let generation: number;
    try {
      ({ url, generation } = await getWebhookDeliveryTarget());
    } catch (err) {
      // A failed read is not "no webhook" or "generation 0": leave the local
      // queue and every outbox entry untouched so the next pass (or the
      // ticker's retry sweep) delivers them instead of marking them sent or
      // skipped.
      console.error("[announce] webhook target read failed, leaving announcements queued:", errorLabel(err));
      return;
    }
    if (!url) {
      queue = [];
      return;
    }
    const pending = await outboxPending();
    const candidates: { id: string; entry: OutboxEntry }[] = [];
    // An entry is stale if the webhook changed after it was enqueued
    // (generation) or its switch was disabled and re-enabled (epoch). Both
    // counters were captured with this config read; a producer that raced the
    // disabling write still carries the old one.
    for (const item of pending) {
      // A NEWER epoch or generation means this pass's snapshot predates a
      // re-enable or a fresh webhook. Leave it pending for a pass with fresh
      // config instead of terminally skipping an entry that may still be
      // valid.
      if (item.entry.kindEpoch > config.kindEpochs[item.entry.kind]) continue;
      if (item.entry.webhookGeneration > generation) continue;
      if (
        item.entry.webhookGeneration !== generation ||
        item.entry.kindEpoch !== config.kindEpochs[item.entry.kind]
      ) {
        await outboxSkip(item.id);
        continue;
      }
      if (!kindEnabled(config, item.entry.kind)) {
        await outboxSkip(item.id);
        continue;
      }
      candidates.push(item);
    }
    // The local queue has served its purpose (bounded ids for the drop
    // policy); the outbox is the source of truth from here.
    queue = [];

    for (let i = 0; i < candidates.length; i += PACK_EMBEDS) {
      const candidateBatch = candidates.slice(i, i + PACK_EMBEDS);
      const batch: { item: { id: string; entry: OutboxEntry }; token: string }[] = [];
      for (const item of candidateBatch) {
        const token = await outboxClaim(item.id, item.entry);
        if (token) batch.push({ item, token });
      }
      if (batch.length === 0) continue;
      const embeds = batch.flatMap(({ item }) => {
        const payload = item.entry.payload as DiscordMessage | null;
        return Array.isArray(payload?.embeds) ? payload.embeds : [];
      });
      if (embeds.length === 0) {
        for (const { item, token } of batch) await outboxComplete(item.id, "failed", token);
        continue;
      }
      const body = { embeds: embeds.slice(0, PACK_EMBEDS), allowed_mentions: { parse: [] } };
      const result = await postToDiscord(url, body);
      if (result.retryAfterMs !== undefined) {
        // 429: release the leases WITHOUT recording an attempt, park the
        // sweeps, and stop this pass — later batches would be refused too.
        await setAnnounceCooldown(result.retryAfterMs);
        for (const { item, token } of batch) await outboxRelease(item.id, token);
        return;
      }
      const ok = result.ok;
      for (const { item, token } of batch) {
        await outboxComplete(item.id, ok ? "sent" : "failed", token);
        await bumpStatus(item.entry.kind, ok ? "sent" : "failed", ok ? undefined : "discord post failed");
      }
    }
    await outboxPrune();
  } catch (err) {
    console.error("[announce] flush failed:", errorLabel(err));
  } finally {
    flushing = false;
  }
}

/** The ticker's sweep: re-deliver `failed` entries that still have attempts
 *  remaining AND `pending` entries stranded by a restart or an interrupted
 *  flush. Same lease + pack + kind-filter discipline as `flush`, so a retry
 *  and a fresh flush can never both deliver. */
export async function flushRetries(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    if ((await announceCooldownMs()) > 0) return;
    const config = await getAnnounceConfig();
    if (!config.webhookConfigured) return;
    let url: string | null;
    let generation: number;
    try {
      ({ url, generation } = await getWebhookDeliveryTarget());
    } catch (err) {
      // See flush(): a failed paired read leaves pending/retryable entries for
      // the next sweep rather than dropping them.
      console.error("[announce] webhook target read failed, leaving retries queued:", errorLabel(err));
      return;
    }
    if (!url) return;
    const [pending, retryable] = await Promise.all([outboxPending(), outboxRetryable()]);
    // One id can only have one status, but dedupe anyway so a store change
    // (or a concurrent status flip) cannot put the same announcement in two
    // batches of one pass.
    const byId = new Map<string, { id: string; entry: OutboxEntry }>();
    for (const item of [...pending, ...retryable]) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    const candidates: { id: string; entry: OutboxEntry }[] = [];
    for (const item of [...byId.values()].sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at))) {
      // See flush(): a newer epoch or generation belongs to a later config
      // snapshot than this pass saw, so leave it pending rather than
      // terminally skipping it.
      if (item.entry.kindEpoch > config.kindEpochs[item.entry.kind]) continue;
      if (item.entry.webhookGeneration > generation) continue;
      if (
        item.entry.webhookGeneration !== generation ||
        item.entry.kindEpoch !== config.kindEpochs[item.entry.kind]
      ) {
        await outboxSkip(item.id);
        continue;
      }
      if (!kindEnabled(config, item.entry.kind)) {
        await outboxSkip(item.id);
        continue;
      }
      candidates.push(item);
    }
    for (let i = 0; i < candidates.length; i += PACK_EMBEDS) {
      const candidateBatch = candidates.slice(i, i + PACK_EMBEDS);
      const batch: { item: { id: string; entry: OutboxEntry }; token: string }[] = [];
      for (const item of candidateBatch) {
        const token = await outboxClaim(item.id, item.entry);
        if (token) batch.push({ item, token });
      }
      if (batch.length === 0) continue;
      const embeds = batch.flatMap(({ item }) => {
        const payload = item.entry.payload as DiscordMessage | null;
        return Array.isArray(payload?.embeds) ? payload.embeds : [];
      });
      if (embeds.length === 0) {
        for (const { item, token } of batch) await outboxComplete(item.id, "failed", token);
        continue;
      }
      const body = { embeds: embeds.slice(0, PACK_EMBEDS), allowed_mentions: { parse: [] } };
      const result = await postToDiscord(url, body);
      if (result.retryAfterMs !== undefined) {
        await setAnnounceCooldown(result.retryAfterMs);
        for (const { item, token } of batch) await outboxRelease(item.id, token);
        return;
      }
      const ok = result.ok;
      for (const { item, token } of batch) {
        await outboxComplete(item.id, ok ? "sent" : "failed", token);
        await bumpStatus(item.entry.kind, ok ? "sent" : "failed", ok ? undefined : "discord post failed (retry)");
      }
    }
  } catch (err) {
    console.error("[announce] retry flush failed:", errorLabel(err));
  } finally {
    flushing = false;
  }
}

/** One POST. `body` is already the assembled Discord payload (embeds +
 *  a hard `allowed_mentions: { parse: [] }`); the URL and the body are
 *  never logged, whatever happens. `redirect: "manual"` keeps a 3xx from
 *  the endpoint answering as a "success": delivery is recorded from THIS
 *  response alone, so a redirect-following fetch that lands on an error
 *  page cannot mark a post sent (nor one that lands elsewhere can fail a
 *  post Discord accepted). */
export type DiscordPostResult = { ok: boolean; retryAfterMs?: number };

export async function postToDiscord(url: string, body: unknown): Promise<DiscordPostResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 429) {
        // Discord's Retry-After is authoritative. Prefer the header, fall
        // back to the JSON `retry_after` seconds, and default to one second
        // if the response carried neither — never retry immediately.
        let retryAfterMs: number | undefined;
        try {
          const header = res.headers?.get?.("retry-after");
          if (header) retryAfterMs = Number(header) * 1000;
        } catch {
          // A response mock without headers still gets the JSON fallback.
        }
        if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
          try {
            const parsed = (await res.json()) as { retry_after?: unknown };
            const seconds = Number(parsed?.retry_after);
            if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = seconds * 1000;
          } catch {
            // No parseable body: use the conservative default below.
          }
        }
        if (retryAfterMs === undefined) retryAfterMs = 1_000;
        console.error("[announce] discord post rate limited: HTTP 429");
        return { ok: false, retryAfterMs };
      }
      console.error(`[announce] discord post failed: HTTP ${res.status}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error("[announce] discord post failed:", errorLabel(err));
    return { ok: false };
  }
}
