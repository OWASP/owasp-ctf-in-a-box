import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel } from "@/lib/admin-store";
import { getAdminSettings } from "@/lib/admin-store";
import { DEFAULT_EVENT_IDENTITY } from "@/lib/event-identity";
import { buildTestMessage } from "@/lib/announce/messages";
import { announceCooldownMs, getWebhookUrl, setAnnounceCooldown } from "@/lib/announce/store";
import { postToDiscord } from "@/lib/announce/sender";

/**
 * Send ONE test message to the configured webhook, right now (#590).
 * Deliberately direct (not via the outbox): a test is synchronous feedback
 * for the organizer, and its result — ok or failure — is the point. The
 * response carries only the outcome, never the URL; a failure logs a status
 * line or a label, never the endpoint.
 */

/** 429 shaped like Discord's own: a Retry-After the admin UI (and any
 *  client) can honour, and a body error string the panel already renders. */
function rateLimited(retryAfterMs: number) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  return NextResponse.json(
    { ok: false, error: `Discord rate limit is active — retry in ${seconds}s` },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  try {
    // The shared cooldown is Discord's, not the sender's: a test send that
    // ignored it would hit the same 429 the sweeps are waiting out, and a
    // test that itself draws a 429 must park the scheduled deliveries too —
    // otherwise the outbox posts before the retry instant.
    const remaining = await announceCooldownMs();
    if (remaining > 0) return rateLimited(remaining);

    const url = await getWebhookUrl();
    if (!url) return NextResponse.json({ error: "no webhook configured" }, { status: 400 });

    let eventName = DEFAULT_EVENT_IDENTITY.eventName;
    try {
      const settings = await getAdminSettings();
      const stored = settings.eventIdentity.eventName;
      if (stored && stored.trim() !== "") eventName = stored;
    } catch {
      // A settings blip must not stop a test whose URL is already in hand;
      // fall back to the default event name.
    }

    const result = await postToDiscord(url, buildTestMessage(eventName));
    if (result.retryAfterMs !== undefined) {
      await setAnnounceCooldown(result.retryAfterMs);
      return rateLimited(result.retryAfterMs);
    }
    return result.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: "Discord rejected the test message (see the server log for the status)" }, { status: 502 });
  } catch (err) {
    console.error("[admin/announcements] test send failed:", adminErrorLabel(err));
    return NextResponse.json({ error: "announcements store unavailable" }, { status: 503 });
  }
}
