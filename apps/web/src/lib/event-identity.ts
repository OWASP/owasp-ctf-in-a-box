// The event's identity fields (issue #386): the five things an organizer names
// the event by, stored in ctf:admin:settings and edited on the Event tab's
// Identity section. Client-safe on purpose — the Event tab reads the limits
// for its inputs' maxLength — so this file must never import server-only code.

export const EVENT_IDENTITY_KEYS = ["eventName", "eventTheme", "eventLocation", "eventContact", "eventDiscord"] as const;
export type EventIdentityKey = (typeof EVENT_IDENTITY_KEYS)[number];
/** The organizer's stored values, keyed by field. Absent = default. */
export type EventIdentityOverrides = Partial<Record<EventIdentityKey, string>>;

export const EVENT_NAME_MAX = 80;
export const EVENT_THEME_MAX = 160;
export const EVENT_LOCATION_MAX = 160;
export const EVENT_CONTACT_MAX = 254;
export const EVENT_DISCORD_MAX = 200;

export const EVENT_IDENTITY_MAX: Record<EventIdentityKey, number> = {
  eventName: EVENT_NAME_MAX,
  eventTheme: EVENT_THEME_MAX,
  eventLocation: EVENT_LOCATION_MAX,
  eventContact: EVENT_CONTACT_MAX,
  eventDiscord: EVENT_DISCORD_MAX,
};

/** Spec §2 defaults. Empty means "hide" for every field but the name — pages
 *  drop their tagline, location line, mailto and Discord links when unset. */
export const DEFAULT_EVENT_IDENTITY: Record<EventIdentityKey, string> = {
  eventName: "OWASP CTF in a Box",
  eventTheme: "",
  eventLocation: "",
  eventContact: "",
  eventDiscord: "",
};

const KEY_SET = new Set<string>(EVENT_IDENTITY_KEYS);
export function isEventIdentityKey(k: string): k is EventIdentityKey {
  return KEY_SET.has(k);
}

// Sibling of admin-store.ts's CONTROL_CHARS_RE — duplicated rather than
// imported because admin-store is server-only and this module is not.
const IDENTITY_CONTROL_CHARS_RE = /[\x00-\x1f\x7f‪-‮⁦-⁩]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type IdentityCheck = { ok: true; value: string } | { ok: false; message: string };

/** Trims and validates one identity value. An empty trimmed value is OK with
 *  `value: ""` — the caller treats it as "clear back to the default". */
export function checkEventIdentityValue(key: EventIdentityKey, raw: unknown): IdentityCheck {
  if (typeof raw !== "string") return { ok: false, message: `${key} must be a string` };
  const value = raw.trim();
  if (IDENTITY_CONTROL_CHARS_RE.test(value)) return { ok: false, message: `${key} must not contain control characters` };
  const max = EVENT_IDENTITY_MAX[key];
  if (value.length > max) return { ok: false, message: `${key} must be at most ${max} characters` };
  if (value === "") return { ok: true, value };
  if (key === "eventContact" && !EMAIL_RE.test(value)) return { ok: false, message: "eventContact must be an e-mail address" };
  if (key === "eventDiscord") {
    let parsed: URL | null = null;
    try { parsed = new URL(value); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== "https:" || !parsed.hostname) {
      return { ok: false, message: "eventDiscord must be an https:// URL" };
    }
  }
  return { ok: true, value };
}
