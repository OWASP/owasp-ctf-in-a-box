import { NextResponse } from "next/server";
import { readBoundedBody } from "@/lib/bounded-body";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel } from "@/lib/admin-store";
import type { DiscordConfigPatch } from "@/lib/discord-config";
import { AnnounceValidationError, getAnnounceConfig, publicConfig, readStatus, updateAnnounceConfig } from "@/lib/announce/store";

/**
 * The /admin → Event "Discord announcements" section's config endpoint
 * (#590). GET returns the public config (never the webhook URL —
 * `publicConfig` replaces it with a `webhookConfigured` boolean) plus the
 * delivery status counters. POST applies a switches/options patch; the
 * webhook URL is deliberately NOT settable here — it has its own endpoint
 * (`./webhook`) so the secret never rides in the same request as the
 * preference fields, and so a config save can never accidentally echo it
 * back. Admin-gated; the CSRF origin check runs in proxy.ts for every
 * mutating /api/* route, this one included.
 */

const MAX_BODY_BYTES = 4_096;

const PATCH_KEYS = new Set([
  "releases",
  "firstBlood",
  "leaders",
  "leaderScope",
  "launch",
  "pause",
  "registration",
  "milestones",
  "marks",
  "daily",
  "dailyAt",
  "dailyTopN",
]);

/** JSON object guard: arrays and nulls are not patch payloads. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** GET: the public config (never the webhook URL) plus the delivery status
 *  counters. */
export async function GET(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  try {
    const [config, status] = await Promise.all([getAnnounceConfig(), readStatus()]);
    return NextResponse.json({ config: publicConfig(config), status });
  } catch (err) {
    console.error("[admin/announcements] read failed:", adminErrorLabel(err));
    return NextResponse.json({ error: "announcements store unavailable" }, { status: 503 });
  }
}

/** POST: applies a switches/options patch. Unknown keys are refused with a
 *  FIXED message (the submitted key is never echoed back); a validation
 *  refusal is a 400 naming the field and the rule; anything else is a 503 —
 *  the webhook URL has its own endpoint and is not settable here. */
export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const bounded = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!bounded.ok) {
    return NextResponse.json({ error: bounded.reason === "too_large" ? "request body too large" : "invalid request payload" }, { status: bounded.reason === "too_large" ? 413 : 400 });
  }
  let body: unknown;
  try {
    body = bounded.body === "" ? {} : JSON.parse(bounded.body);
  } catch {
    return NextResponse.json({ error: "invalid request payload" }, { status: 400 });
  }
  if (!isPlainObject(body)) return NextResponse.json({ error: "invalid request payload" }, { status: 400 });
  for (const key of Object.keys(body)) {
    // Fixed message: the submitted key itself is never echoed back, so a
    // secret-like marker smuggled into a key cannot reach the response.
    if (!PATCH_KEYS.has(key)) return NextResponse.json({ error: "unknown setting" }, { status: 400 });
  }

  try {
    const config = await updateAnnounceConfig(gate.login, body as DiscordConfigPatch);
    return NextResponse.json({ config });
  } catch (err) {
    if (err instanceof AnnounceValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[admin/announcements] config write failed:", adminErrorLabel(err));
    return NextResponse.json({ error: "announcements store unavailable" }, { status: 503 });
  }
}
