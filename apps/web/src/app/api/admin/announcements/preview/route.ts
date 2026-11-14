import { NextResponse } from "next/server";
import { readBoundedBody } from "@/lib/bounded-body";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel } from "@/lib/admin-store";
import { getAdminSettings } from "@/lib/admin-store";
import { DEFAULT_EVENT_IDENTITY } from "@/lib/event-identity";
import { isAnnouncementKind, type AnnouncementKind } from "@/lib/discord-config";
import { buildFirstBloodMessage, buildLifecycleMessage, type DiscordMessage } from "@/lib/announce/messages";

/**
 * Build (but never send) a sample of one announcement kind (#590), so the
 * /admin section can render an embed preview before anything is configured.
 * Pure: the same builders the live announcer uses, fed SAMPLE public
 * metadata — a challenge title, a team name, points — never real stored
 * content and never any secret. The webhook URL is not read at all.
 */

const MAX_BODY_BYTES = 1_024;

/** The SAMPLE message for one known kind — no stored content, no webhook. */
function sample(kind: AnnouncementKind, eventName: string): DiscordMessage {
  switch (kind) {
    case "first-blood":
      return buildFirstBloodMessage({ challengeTitle: "Sample challenge", points: 100, who: "sample-team", url: "https://example.invalid/flags/sample" });
    case "launch":
    case "pause":
    case "resume":
    case "milestone":
      return buildLifecycleMessage({ kind, eventName, timeLeft: kind === "milestone" ? "1h 0m" : undefined });
  }
}

/** POST: 200 `{ message }` for a known kind, 400 for an unknown one;
 *  admin-gated before the body is read. Sends nothing. */
export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const bounded = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!bounded.ok) return NextResponse.json({ error: "invalid request payload" }, { status: 400 });
  let body: unknown;
  try {
    body = bounded.body === "" ? {} : JSON.parse(bounded.body);
  } catch {
    return NextResponse.json({ error: "invalid request payload" }, { status: 400 });
  }
  const kind = typeof body === "object" && body !== null ? (body as Record<string, unknown>).kind : undefined;
  if (!isAnnouncementKind(kind)) {
    return NextResponse.json({ error: "unknown announcement kind" }, { status: 400 });
  }

  try {
    let eventName = DEFAULT_EVENT_IDENTITY.eventName;
    try {
      const settings = await getAdminSettings();
      const stored = settings.eventIdentity.eventName;
      if (stored && stored.trim() !== "") eventName = stored;
    } catch {
      // Preview is cosmetic; a settings blip previews under the default name.
    }
    return NextResponse.json({ kind, message: sample(kind, eventName) });
  } catch (err) {
    console.error("[admin/announcements] preview failed:", adminErrorLabel(err));
    return NextResponse.json({ error: "preview unavailable" }, { status: 503 });
  }
}
