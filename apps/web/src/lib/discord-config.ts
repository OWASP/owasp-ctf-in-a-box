// Discord announcement configuration (#590): validation and limits, in a
// pure client-safe leaf (no `server-only`) so the /admin Event section and
// the server-side store share ONE copy of every rule — the same split
// event-identity.ts / admin-store.ts already use.
//
// The webhook URL is the only secret in this config. It is stored in its own
// Redis key (see announce/keys.ts), never returned to the client, never
// logged, and never recorded in the audit trail (only "set"/"cleared").
// Every other field here is an ordinary organizer preference.

/** Every announcement type defaults to OFF, and configuring a webhook never
 *  turns one on — an organizer opts each stream in deliberately. The whole
 *  scope is first blood, launch/pause/resume and the time-left marks; the
 *  store refuses any other field (unknown keys are an error, not a no-op). */
export const DISCORD_DEFAULTS = {
  firstBlood: false,
  launch: false,
  pause: false,
  milestones: false,
  marks: "1h, 15m",
};

/** The non-secret half of the config — exactly what an API response may
 *  carry. The webhook URL is deliberately NOT a field here: the public shape
 *  cannot leak what it never has. */
export type DiscordPublicConfig = {
  webhookConfigured: boolean;
  firstBlood: boolean;
  launch: boolean;
  pause: boolean;
  milestones: boolean;
  marks: string;
};

/** The server-only full config (announce/store.ts) — the same fields plus
 *  the URL. Never crosses an API boundary. */
export type DiscordFullConfig = DiscordPublicConfig & { webhookUrl: string | null };

/** Announcement kinds, keyed by the config switch that gates them. Used by
 *  the sender's flush-time filter ("stop disabled announcements immediately")
 *  and by the preview route. */
export type AnnouncementKind = "first-blood" | "launch" | "pause" | "resume" | "milestone";

export const ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] = ["first-blood", "launch", "pause", "resume", "milestone"];

/** Whether `value` names one of the announcement kinds. */
export function isAnnouncementKind(value: unknown): value is AnnouncementKind {
  return typeof value === "string" && (ANNOUNCEMENT_KINDS as readonly string[]).includes(value);
}

/** Whether the config switch that gates `kind` is on. `pause` covers both
 *  the pause and the resume edge — they are two faces of one "scoring
 *  paused/resumed" stream. */
export function kindEnabled(config: DiscordPublicConfig, kind: AnnouncementKind): boolean {
  switch (kind) {
    case "first-blood":
      return config.firstBlood;
    case "launch":
      return config.launch;
    case "pause":
    case "resume":
      return config.pause;
    case "milestone":
      return config.milestones;
  }
}

export const DISCORD_WEBHOOK_URL_MAX = 1024;

/** Only Discord's own webhook endpoints, on the https scheme, with the
 *  /api/webhooks/<id>/<token> shape. This is both the SSRF boundary (no
 *  organizer-supplied host ever gets a POST from the box) and the "is this
 *  even a webhook" sanity check — a pasted invite or channel URL is refused
 *  with the reason, instead of failing silently at delivery time. */
const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);
const DISCORD_WEBHOOK_PATH_RE = /^\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,}$/;

/** Validates a submitted webhook URL. Every refusal message is FIXED — it
 *  names the rule, never any part of the submitted URL, so the secret
 *  cannot be echoed back through an admin-visible error. */
export function checkDiscordWebhookUrl(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "webhook URL must be a string" };
  // Checked on the RAW input, before any trimming: a pasted URL ending in a
  // newline or carrying a smuggled control character is refused outright,
  // rather than quietly normalised — only ordinary surrounding spaces are
  // trimmed away below.
  if (/[\x00-\x1f\x7f]/.test(raw)) return { ok: false, message: "webhook URL must not contain control characters" };
  const value = raw.trim();
  if (value === "") return { ok: false, message: "webhook URL is empty — clear it with the Clear button instead" };
  if (value.length > DISCORD_WEBHOOK_URL_MAX) {
    return { ok: false, message: `webhook URL must be at most ${DISCORD_WEBHOOK_URL_MAX} characters` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "webhook URL must be a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, message: "webhook URL must use https://" };
  if (url.username || url.password) return { ok: false, message: "webhook URL must not carry credentials" };
  if (!DISCORD_WEBHOOK_HOSTS.has(url.hostname)) {
    return { ok: false, message: "webhook URL must be on discord.com (a Discord webhook URL, not an invite)" };
  }
  if (url.search || url.hash) return { ok: false, message: "webhook URL must not carry a query string or fragment" };
  if (!DISCORD_WEBHOOK_PATH_RE.test(url.pathname)) {
    return { ok: false, message: "webhook URL must end in /api/webhooks/<id>/<token>" };
  }
  return { ok: true, value: url.toString() };
}

export const DISCORD_MARKS_MAX = 10;
const MARK_RE = /^(\d+)\s*(s|m|h|d)$/i;
const MARK_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
export const MARK_MIN_MS = 60_000;
export const MARK_MAX_MS = 7 * 86_400_000;

/** Parses the remaining-time marks field ("1h, 30m, 5m") into milliseconds,
 *  sorted ascending, or reports why it cannot. Empty/whitespace-only is a
 *  valid "no marks" value. Each mark is `<n><s|m|h|d>`, at least a minute and
 *  at most seven days, at most DISCORD_MARKS_MAX of them. Every refusal is a
 *  FIXED message naming the entry's position and the rule — never the
 *  submitted text — so an admin-visible error cannot echo a secret-like
 *  value back (this field is free text a request can put anything in). */
export function parseMarks(raw: unknown): { ok: true; marks: number[] } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "marks must be a string like \"1h, 15m\"" };
  const text = raw.trim();
  if (text === "") return { ok: true, marks: [] };
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length > DISCORD_MARKS_MAX) {
    return { ok: false, message: `at most ${DISCORD_MARKS_MAX} marks, comma-separated` };
  }
  const marks: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const m = MARK_RE.exec(part);
    if (!m) return { ok: false, message: `mark ${i + 1} is not a duration like 45m, 2h or 1d` };
    const ms = Number(m[1]) * MARK_MS[m[2].toLowerCase()];
    if (ms < MARK_MIN_MS) return { ok: false, message: `mark ${i + 1} is under a minute — the smallest mark is 1m` };
    if (ms > MARK_MAX_MS) return { ok: false, message: `mark ${i + 1} is over seven days` };
    marks.push(ms);
  }
  return { ok: true, marks: [...new Set(marks)].sort((a, b) => a - b) };
}

/** A field patch accepted by the config store. Every field optional; the
 *  store validates each one and refuses unknown keys, exactly like
 *  updateAdminSettings. */
export type DiscordConfigPatch = Partial<{
  firstBlood: boolean;
  launch: boolean;
  pause: boolean;
  milestones: boolean;
  marks: string;
}>;

export const DISCORD_BOOL_KEYS = ["firstBlood", "launch", "pause", "milestones"] as const;
