// Pure helpers for the Event tab's image pickers (#529). They refuse an
// obvious mistake before the round trip and say why; the SERVER still decides
// from the decoded bytes (event-images-store.ts), so nothing here is a
// security control. Every limit comes from event-images-keys.ts.

import {
  EVENT_ICON_MAX_DIMENSION,
  EVENT_ICON_MIN_DIMENSION,
  EVENT_IMAGE_MAX_BYTES,
  EVENT_IMAGE_MIME_TYPES,
  EVENT_LOGO_MAX_DIMENSION,
  type EventImageMeta,
  type EventImageSlot,
} from "@/lib/event-images-keys";

export const SLOT_LABEL: Record<EventImageSlot, string> = { logo: "Logo", icon: "Favicon" };

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** An error to show, or null when the file may be sent. */
export function checkPickedFile(slot: EventImageSlot, file: { type: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.type === "image/svg+xml") return "SVG is not accepted — it can run script. Export it as PNG, JPEG or WebP.";
  if (!EVENT_IMAGE_MIME_TYPES[slot].includes(file.type)) {
    return slot === "icon" ? "The favicon must be a PNG." : "The logo must be a PNG, JPEG or WebP image.";
  }
  const max = EVENT_IMAGE_MAX_BYTES[slot];
  if (file.size > max) return `${SLOT_LABEL[slot]} files are capped at ${kb(max)}.`;
  return null;
}

/** Checked once the browser has decoded the image. */
export function checkPickedDimensions(slot: EventImageSlot, w: number, h: number): string | null {
  if (slot === "icon") {
    if (w !== h) return "The favicon must be square.";
    if (w < EVENT_ICON_MIN_DIMENSION || w > EVENT_ICON_MAX_DIMENSION) {
      return `The favicon must be between ${EVENT_ICON_MIN_DIMENSION} and ${EVENT_ICON_MAX_DIMENSION} pixels a side.`;
    }
    return null;
  }
  if (w > EVENT_LOGO_MAX_DIMENSION || h > EVENT_LOGO_MAX_DIMENSION) {
    return `The logo must be at most ${EVENT_LOGO_MAX_DIMENSION} pixels a side.`;
  }
  return null;
}

const TYPE_LABEL: Record<EventImageMeta["type"], string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP" };

export function describeStoredImage(meta: EventImageMeta): string {
  return `${meta.w}×${meta.h} ${TYPE_LABEL[meta.type]}, ${kb(meta.bytes)}`;
}

/** The help line under each picker. */
export const SLOT_HELP: Record<EventImageSlot, string> = {
  logo: `Leads the landing page's hero, with a smaller OWASP mark kept beside it. Shown as uploaded on the dark navy hero, so upload a version made for a dark background. PNG, JPEG or WebP, up to ${kb(EVENT_IMAGE_MAX_BYTES.logo)}.`,
  icon: `The browser tab icon. A square PNG, ${EVENT_ICON_MIN_DIMENSION}–${EVENT_ICON_MAX_DIMENSION} pixels, up to ${kb(EVENT_IMAGE_MAX_BYTES.icon)}.`,
};

/** Every client-side check, in order, before anything is sent: an error to
 *  show, or null. `decode` reads the image's real dimensions (the component
 *  passes createImageBitmap); it is only called once type and size pass.
 *  Pure of the component's state on purpose — a refused pick must not touch
 *  the upload sequence, or it would orphan a save already in flight. */
export async function prepareUpload(
  slot: EventImageSlot,
  file: { type: string; size: number },
  decode: () => Promise<{ w: number; h: number } | null>,
): Promise<string | null> {
  const early = checkPickedFile(slot, file);
  if (early) return early;
  const size = await decode();
  if (!size) return "That file does not open as an image.";
  return checkPickedDimensions(slot, size.w, size.h);
}
