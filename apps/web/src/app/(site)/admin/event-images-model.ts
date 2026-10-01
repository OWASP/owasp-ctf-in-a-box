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
  type EventImagesMeta,
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

/** The section's state. Each slot has its OWN in-flight guard, taken before
 *  any async validation and released only by that slot's own finish/fail, so
 *  a favicon upload can never re-enable a logo upload still in flight — two
 *  overlapping writes to one slot could land out of order in Redis. Nothing
 *  is editable until the first read lands (`loaded`), so a slow first read
 *  can never overwrite what an upload just saved. */
export type ImagesState = {
  images: EventImagesMeta;
  loaded: boolean;
  loadError: string | null;
  busy: Record<EventImageSlot, boolean>;
};

export type ImagesAction =
  | { type: "loaded"; images: EventImagesMeta }
  | { type: "load-failed"; message: string }
  | { type: "start"; slot: EventImageSlot }
  | { type: "finish"; slot: EventImageSlot; image: EventImageMeta | null }
  | { type: "fail"; slot: EventImageSlot };

export const INITIAL_IMAGES_STATE: ImagesState = {
  images: {},
  loaded: false,
  loadError: null,
  busy: { logo: false, icon: false },
};

export function imagesReducer(state: ImagesState, action: ImagesAction): ImagesState {
  switch (action.type) {
    case "loaded":
      return { ...state, images: action.images, loaded: true, loadError: null };
    case "load-failed":
      return { ...state, loadError: action.message };
    case "start":
      return { ...state, busy: { ...state.busy, [action.slot]: true } };
    case "finish": {
      const images = { ...state.images };
      if (action.image) images[action.slot] = action.image;
      else delete images[action.slot];
      return { ...state, images, busy: { ...state.busy, [action.slot]: false } };
    }
    case "fail":
      return { ...state, busy: { ...state.busy, [action.slot]: false } };
  }
}

/** Whether a slot's controls are disabled. */
export function isPending(state: ImagesState, slot: EventImageSlot): boolean {
  return !state.loaded || state.loadError !== null || state.busy[slot];
}

/** Whether an operation on this slot may begin now. */
export function canStart(state: ImagesState, slot: EventImageSlot): boolean {
  return !isPending(state, slot);
}
