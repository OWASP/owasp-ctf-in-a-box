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
 *  turns one on — an organizer opts each stream in deliberately. */
export const DISCORD_DEFAULTS = {
  releases: false,
  firstBlood: false,
  leaders: false,
  leaderScope: "first" as const,
  launch: false,
  pause: false,
  registration: false,
  milestones: false,
  marks: "1h, 15m",
  daily: false,
  dailyAt: "09:00",
  dailyTopN: 10,
};

export type DiscordLeaderScope = "first" | "top3";

/** The non-secret half of the config — exactly what an API response may
 *  carry. The webhook URL is deliberately NOT a field here: the public shape
 *  cannot leak what it never has. */
export type DiscordPublicConfig = {
  webhookConfigured: boolean;
  releases: boolean;
  firstBlood: boolean;
  leaders: boolean;
  leaderScope: DiscordLeaderScope;
  launch: boolean;
  pause: boolean;
  registration: boolean;
  milestones: boolean;
  marks: string;
  daily: boolean;
  dailyAt: string;
  dailyTopN: number;
};

/** The server-only full config (announce/store.ts) — the same fields plus
 *  the URL. Never crosses an API boundary. */
export type DiscordFullConfig = DiscordPublicConfig & { webhookUrl: string | null };

/** Announcement kinds, keyed by the config switch that gates them. Used by
 *  the sender's flush-time filter ("stop disabled announcements immediately")
 *  and by the preview route. */
export type AnnouncementKind =
  | "release"
  | "first-blood"
  | "leader"
  | "launch"
  | "pause"
  | "resume"
  | "registration-closed"
  | "milestone"
  | "daily";

export const ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] = [
  "release",
  "first-blood",
  "leader",
  "launch",
  "pause",
  "resume",
  "registration-closed",
  "milestone",
  "daily",
];

export function isAnnouncementKind(value: unknown): value is AnnouncementKind {
  return typeof value === "string" && (ANNOUNCEMENT_KINDS as readonly string[]).includes(value);
}

/** Which switch gates which kind. `pause` covers both the pause and the
 *  resume edge — they are two faces of one "scoring paused/resumed" stream. */
export function kindEnabled(config: DiscordPublicConfig, kind: AnnouncementKind): boolean {
  switch (kind) {
    case "release":
      return config.releases;
    case "first-blood":
      return config.firstBlood;
    case "leader":
      return config.leaders;
    case "launch":
      return config.launch;
    case "pause":
    case "resume":
      return config.pause;
    case "registration-closed":
      return config.registration;
    case "milestone":
      return config.milestones;
    case "daily":
      return config.daily;
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
 *  at most seven days, at most DISCORD_MARKS_MAX of them. */
export function parseMarks(raw: unknown): { ok: true; marks: number[] } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "marks must be a string like \"1h, 15m\"" };
  const text = raw.trim();
  if (text === "") return { ok: true, marks: [] };
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length > DISCORD_MARKS_MAX) {
    return { ok: false, message: `at most ${DISCORD_MARKS_MAX} marks, comma-separated` };
  }
  const marks: number[] = [];
  for (const part of parts) {
    const m = MARK_RE.exec(part);
    if (!m) return { ok: false, message: `"${part}" is not a mark — use forms like 45m, 2h, 1d` };
    const ms = Number(m[1]) * MARK_MS[m[2].toLowerCase()];
    if (ms < MARK_MIN_MS) return { ok: false, message: `"${part}" is under a minute — the smallest mark is 1m` };
    if (ms > MARK_MAX_MS) return { ok: false, message: `"${part}" is over seven days` };
    marks.push(ms);
  }
  return { ok: true, marks: [...new Set(marks)].sort((a, b) => a - b) };
}

const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function checkDailyAt(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "daily summary time must be HH:MM" };
  const value = raw.trim();
  if (!DAILY_AT_RE.test(value)) return { ok: false, message: "daily summary time must be HH:MM on the event's clock (00:00–23:59)" };
  return { ok: true, value };
}

export const DISCORD_DAILY_TOPN_MIN = 1;
export const DISCORD_DAILY_TOPN_MAX = 50;

export function checkDailyTopN(raw: unknown): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < DISCORD_DAILY_TOPN_MIN || raw > DISCORD_DAILY_TOPN_MAX) {
    return { ok: false, message: `top N must be an integer in [${DISCORD_DAILY_TOPN_MIN}, ${DISCORD_DAILY_TOPN_MAX}]` };
  }
  return { ok: true, value: raw };
}

export function checkLeaderScope(raw: unknown): { ok: true; value: DiscordLeaderScope } | { ok: false; message: string } {
  if (raw === "first" || raw === "top3") return { ok: true, value: raw };
  return { ok: false, message: 'leader scope must be "first" or "top3"' };
}

/** A field patch accepted by the config store. Every field optional; the
 *  store validates each one and refuses unknown keys, exactly like
 *  updateAdminSettings. */
export type DiscordConfigPatch = Partial<{
  releases: boolean;
  firstBlood: boolean;
  leaders: boolean;
  leaderScope: DiscordLeaderScope;
  launch: boolean;
  pause: boolean;
  registration: boolean;
  milestones: boolean;
  marks: string;
  daily: boolean;
  dailyAt: string;
  dailyTopN: number;
}>;

export const DISCORD_BOOL_KEYS = ["releases", "firstBlood", "leaders", "launch", "pause", "registration", "milestones", "daily"] as const;
