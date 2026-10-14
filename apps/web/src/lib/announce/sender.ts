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
// such in ADR 69.
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
  bumpStatus,
  getAnnounceConfig,
  getWebhookUrl,
  outboxClaimLease,
  outboxComplete,
  outboxEnqueue,
  outboxPending,
  outboxPrune,
  outboxRetryable,
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
let enqueueCounter = 0;
let droppedCount = 0;

/** How many enqueues were dropped by the bound. Admin-facing cosmetic. */
export function droppedEnqueues(): number {
  return droppedCount;
}

/** The outbox id for one enqueue: time + an in-process counter + the kind,
 *  so a same-millisecond burst never collides. */
function nextId(kind: AnnouncementKind): string {
  enqueueCounter += 1;
  return `${Date.now()}-${enqueueCounter}-${kind}`;
}

/** Enqueues one announcement, if its switch is on and a webhook is
 *  configured. A disabled kind or an unconfigured box is a NO-OP (no entry,
 *  no timer) — the announcer never accumulates work it will not send. */
export async function enqueueAnnouncement(kind: AnnouncementKind, message: DiscordMessage): Promise<void> {
  const config = await getAnnounceConfig();
  if (!config.webhookConfigured || !kindEnabled(config, kind)) return;
  const id = nextId(kind);
  await outboxEnqueue(id, kind, message);
  queue.push(id);
  while (queue.length > MAX_QUEUE) {
    const droppedId = queue.shift();
    droppedCount += 1;
    if (droppedId) await outboxComplete(droppedId, "skipped");
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
 *  call during a pass returns immediately. */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    queue = queue.filter((id) => id !== ""); // defensive; ids are never ""
    const config = await getAnnounceConfig();
    if (!config.webhookConfigured) {
      queue = [];
      return;
    }
    const url = await getWebhookUrl();
    if (!url) {
      queue = [];
      return;
    }
    const pending = await outboxPending();
    const deliverable: { id: string; entry: OutboxEntry }[] = [];
    for (const item of pending) {
      if (!kindEnabled(config, item.entry.kind)) {
        await outboxComplete(item.id, "skipped");
        continue;
      }
      if (await outboxClaimLease(item.id)) deliverable.push(item);
    }
    // The local queue has served its purpose (bounded ids for the drop
    // policy); the outbox is the source of truth from here.
    queue = [];

    for (let i = 0; i < deliverable.length; i += PACK_EMBEDS) {
      const batch = deliverable.slice(i, i + PACK_EMBEDS);
      const embeds = batch.flatMap((item) => {
        const payload = item.entry.payload as DiscordMessage | null;
        return Array.isArray(payload?.embeds) ? payload.embeds : [];
      });
      if (embeds.length === 0) {
        for (const item of batch) await outboxComplete(item.id, "failed");
        continue;
      }
      const body = { embeds: embeds.slice(0, PACK_EMBEDS), allowed_mentions: { parse: [] } };
      const ok = await postToDiscord(url, body);
      for (const item of batch) {
        await outboxComplete(item.id, ok ? "sent" : "failed");
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

/** The ticker's retry pass: re-deliver `failed` entries that still have
 *  attempts remaining. Same lease + pack + kind-filter discipline as
 *  `flush`, so a retry and a fresh flush can never both deliver. */
export async function flushRetries(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const config = await getAnnounceConfig();
    if (!config.webhookConfigured) return;
    const url = await getWebhookUrl();
    if (!url) return;
    const retryable = await outboxRetryable();
    const deliverable: { id: string; entry: OutboxEntry }[] = [];
    for (const item of retryable) {
      if (!kindEnabled(config, item.entry.kind)) {
        await outboxComplete(item.id, "skipped");
        continue;
      }
      if (await outboxClaimLease(item.id)) deliverable.push(item);
    }
    for (let i = 0; i < deliverable.length; i += PACK_EMBEDS) {
      const batch = deliverable.slice(i, i + PACK_EMBEDS);
      const embeds = batch.flatMap((item) => {
        const payload = item.entry.payload as DiscordMessage | null;
        return Array.isArray(payload?.embeds) ? payload.embeds : [];
      });
      if (embeds.length === 0) {
        for (const item of batch) await outboxComplete(item.id, "failed");
        continue;
      }
      const body = { embeds: embeds.slice(0, PACK_EMBEDS), allowed_mentions: { parse: [] } };
      const ok = await postToDiscord(url, body);
      for (const item of batch) {
        await outboxComplete(item.id, ok ? "sent" : "failed");
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
 *  never logged, whatever happens. */
export async function postToDiscord(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[announce] discord post failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[announce] discord post failed:", errorLabel(err));
    return false;
  }
}
