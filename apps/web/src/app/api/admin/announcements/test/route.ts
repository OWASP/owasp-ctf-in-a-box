import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel } from "@/lib/admin-store";
import { getAdminSettings } from "@/lib/admin-store";
import { DEFAULT_EVENT_IDENTITY } from "@/lib/event-identity";
import { buildTestMessage } from "@/lib/announce/messages";
import { getWebhookUrl } from "@/lib/announce/store";
import { postToDiscord } from "@/lib/announce/sender";

/**
 * Send ONE test message to the configured webhook, right now (#590).
 * Deliberately direct (not via the outbox): a test is synchronous feedback
 * for the organizer, and its result — ok or failure — is the point. The
 * response carries only the outcome, never the URL; a failure logs a status
 * line or a label, never the endpoint.
 */

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  try {
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

    const ok = await postToDiscord(url, buildTestMessage(eventName));
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: "Discord rejected the test message (see the server log for the status)" }, { status: 502 });
  } catch (err) {
    console.error("[admin/announcements] test send failed:", adminErrorLabel(err));
    return NextResponse.json({ error: "announcements store unavailable" }, { status: 503 });
  }
}
