// The event's own images (#529): the landing-page hero logo and the browser
// tab icon. Key names, slots and caps, dependency-free ON PURPOSE (mirrors
// sponsors-keys.ts) so the admin UI can import the caps without pulling in
// the server-only store.
//
// Key layout, split for cost exactly like the sponsor logos:
//   ctf:event:images        hash  slot -> JSON EventImageMeta (no bytes)
//   ctf:event:images:data   hash  slot -> base64 raw image bytes
// Every page render reads only the metadata hash (for the etag and the
// dimensions); the bytes are read only by the two image routes.
//
// NOT in the master reset's RESET_PREFIXES: like the rest of the event's
// identity (name, tagline — stored in ctf:admin:settings, which a reset
// keeps), these brand the event, they are not progress from one run of it.

export const EVENT_IMAGES_KEY = "ctf:event:images";
export const EVENT_IMAGES_DATA_KEY = "ctf:event:images:data";

export const EVENT_IMAGE_SLOTS = ["logo", "icon"] as const;
export type EventImageSlot = (typeof EVENT_IMAGE_SLOTS)[number];

export function isEventImageSlot(value: unknown): value is EventImageSlot {
  return typeof value === "string" && (EVENT_IMAGE_SLOTS as readonly string[]).includes(value);
}

/** Caps on the DECODED bytes — never the base64 string's length. */
export const EVENT_LOGO_MAX_BYTES = 131072;
export const EVENT_ICON_MAX_BYTES = 32768;
export const EVENT_IMAGE_MAX_BYTES: Record<EventImageSlot, number> = {
  logo: EVENT_LOGO_MAX_BYTES,
  icon: EVENT_ICON_MAX_BYTES,
};

/** The logo: any intrinsic size from 1 to this. */
export const EVENT_LOGO_MAX_DIMENSION = 4096;
/** The icon: square, and between these two. Browsers downscale a favicon, so
 *  the floor is about legibility and the ceiling about not shipping a poster
 *  as a 16px tab icon. */
export const EVENT_ICON_MIN_DIMENSION = 32;
export const EVENT_ICON_MAX_DIMENSION = 512;

/** What each slot's file picker offers. The SERVER decides from the decoded
 *  bytes alone (event-images-store.ts) and ignores this list; it exists for
 *  the picker's `accept` and an early client-side refusal. PNG-only for the
 *  icon: every browser takes a PNG favicon, and a JPEG has no transparency. */
export const EVENT_IMAGE_MIME_TYPES: Record<EventImageSlot, readonly string[]> = {
  logo: ["image/png", "image/jpeg", "image/webp"],
  icon: ["image/png"],
};

export type EventImageMeta = {
  type: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  w: number;
  h: number;
  etag: string;
};

export type EventImagesMeta = Partial<Record<EventImageSlot, EventImageMeta>>;

/** The event archive's `eventImages` section: just the bytes, per slot. The
 *  metadata is derived again on import, never trusted from the file. */
export type EventImagesBundle = Partial<Record<EventImageSlot, { data: string }>>;

/** The public URL a slot is served from. */
export const EVENT_IMAGE_PATH: Record<EventImageSlot, string> = {
  logo: "/api/event/logo",
  icon: "/api/event/icon",
};

/** The URL a page links to: the route plus `?v=<etag>`, so a replaced image
 *  is fetched at once instead of after the route's five-minute cache (and,
 *  for the favicon, instead of whenever the browser feels like it). */
export function eventImageUrl(slot: EventImageSlot, meta: EventImageMeta): string {
  return `${EVENT_IMAGE_PATH[slot]}?v=${meta.etag}`;
}
