import { NextResponse } from "next/server";
import { readBoundedBody } from "@/lib/bounded-body";
import { requireAdmin } from "@/lib/admin-auth";
import { adminErrorLabel } from "@/lib/admin-store";
import { AnnounceValidationError, getAnnounceConfig, publicConfig, setAnnounceWebhook } from "@/lib/announce/store";

/**
 * Set or clear the Discord webhook URL (#590). Its OWN endpoint, separate
 * from the switches/config patch, so the secret never rides in the same
 * request as preference fields and can never be echoed back by a config
 * save. The response is only `{ webhookConfigured }` — never the URL.
 */

const MAX_BODY_BYTES = 2_048;

/** POST: 200 `{ config }` with `webhookConfigured` only (the URL itself is
 *  never in the response); a validation refusal is a 400 naming the rule;
 *  admin-gated before the body is read. */
export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });

  const bounded = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!bounded.ok) {
    return NextResponse.json(
      { error: bounded.reason === "too_large" ? "request body too large" : "invalid request payload" },
      { status: bounded.reason === "too_large" ? 413 : 400 },
    );
  }
  let body: unknown;
  try {
    body = bounded.body === "" ? null : JSON.parse(bounded.body);
  } catch {
    return NextResponse.json({ error: "invalid request payload" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid request payload" }, { status: 400 });
  }
  const url = (body as Record<string, unknown>).webhookUrl;
  if (url !== null && typeof url !== "string") {
    return NextResponse.json({ error: "invalid request payload" }, { status: 400 });
  }

  try {
    const result = await setAnnounceWebhook(gate.login, url);
    const config = await getAnnounceConfig();
    return NextResponse.json({ ...result, config: publicConfig(config) });
  } catch (err) {
    if (err instanceof AnnounceValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[admin/announcements] webhook write failed:", adminErrorLabel(err));
    return NextResponse.json({ error: "announcements store unavailable" }, { status: 503 });
  }
}
