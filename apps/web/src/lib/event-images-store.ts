import "server-only";
import { createHash } from "node:crypto";
import { upstashPipeline } from "@/lib/upstash";
import { decodeStrictBase64, sniffRasterImage } from "@/lib/image-sniff";
import {
  EVENT_ICON_MAX_DIMENSION,
  EVENT_ICON_MIN_DIMENSION,
  EVENT_IMAGE_MAX_BYTES,
  EVENT_IMAGE_SLOTS,
  EVENT_IMAGES_DATA_KEY,
  EVENT_IMAGES_KEY,
  EVENT_LOGO_MAX_DIMENSION,
  isEventImageSlot,
  type EventImageMeta,
  type EventImagesBundle,
  type EventImageSlot,
  type EventImagesMeta,
} from "@/lib/event-images-keys";

/**
 * The event's own images (#529): the landing-page hero logo and the favicon.
 * This file is the only place that touches `ctf:event:images*` (key layout in
 * event-images-keys.ts). All validation lives here, not in the admin route,
 * so the route, the archive import and anything added later share one
 * chokepoint.
 *
 * Nothing here is secret — both images are public by design. The care is the
 * same as for sponsor logos: only the decoded bytes decide what is stored
 * (image-sniff.ts), so the public routes never serve anything a browser could
 * run as script.
 */

export class EventImageValidationError extends Error {
  slot: EventImageSlot;
  constructor(slot: EventImageSlot, message: string) {
    super(message);
    this.name = "EventImageValidationError";
    this.slot = slot;
  }
}

/** A raw upload: base64 bytes plus the type the browser claimed, which only
 *  sharpens a refusal message and never decides acceptance. */
export type EventImageInput = { data: string; declaredType?: string };

export type { EventImagesBundle };

const LABEL: Record<EventImageSlot, string> = { logo: "logo", icon: "favicon" };

const SNIFF_MESSAGES = {
  png: "is not a structurally valid PNG",
  webp: "is not a structurally valid WebP",
  jpeg: "is not a structurally valid JPEG",
  svg: "cannot be an SVG — an SVG served from this origin can run script. Export it as PNG, JPEG or WebP.",
  unknown: "must be a PNG, JPEG or WebP image",
} as const;

/** Decodes and validates one upload for one slot. Throws
 *  `EventImageValidationError`; touches nothing. */
export function validateEventImage(slot: EventImageSlot, input: EventImageInput): { bytes: Buffer; meta: EventImageMeta } {
  const label = LABEL[slot];
  const fail = (message: string): never => {
    throw new EventImageValidationError(slot, `The ${label} ${message}`);
  };
  const bytes = decodeStrictBase64(input.data);
  if (!bytes) return fail("data is not valid base64");
  if (bytes.length === 0) return fail("upload is empty");
  const max = EVENT_IMAGE_MAX_BYTES[slot];
  if (bytes.length > max) return fail(`must be at most ${Math.round(max / 1024)} KB`);

  const sniffed = sniffRasterImage(bytes, input.declaredType);
  if (!sniffed.ok) return fail(SNIFF_MESSAGES[sniffed.reason]);

  if (slot === "icon") {
    if (sniffed.type !== "image/png") return fail("must be a PNG");
    if (sniffed.w !== sniffed.h) return fail("must be square");
    if (sniffed.w < EVENT_ICON_MIN_DIMENSION || sniffed.w > EVENT_ICON_MAX_DIMENSION) {
      return fail(`must be between ${EVENT_ICON_MIN_DIMENSION} and ${EVENT_ICON_MAX_DIMENSION} pixels a side`);
    }
  } else if (sniffed.w > EVENT_LOGO_MAX_DIMENSION || sniffed.h > EVENT_LOGO_MAX_DIMENSION) {
    return fail(`must be at most ${EVENT_LOGO_MAX_DIMENSION} pixels a side`);
  }

  const etag = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { bytes, meta: { type: sniffed.type, bytes: bytes.length, w: sniffed.w, h: sniffed.h, etag } };
}

function writeCommands(slot: EventImageSlot, bytes: Buffer, meta: EventImageMeta): (string | number)[][] {
  return [
    ["HSET", EVENT_IMAGES_KEY, slot, JSON.stringify(meta)],
    ["HSET", EVENT_IMAGES_DATA_KEY, slot, bytes.toString("base64")],
  ];
}

async function runWrite(commands: (string | number)[][]): Promise<void> {
  const results = await upstashPipeline(commands);
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Upstash event image write failed: ${failed.error}`);
}

/** Replaces one slot's image. Metadata and bytes land in one pipeline. */
export async function setEventImage(slot: EventImageSlot, input: EventImageInput): Promise<EventImageMeta> {
  const { bytes, meta } = validateEventImage(slot, input);
  await runWrite(writeCommands(slot, bytes, meta));
  return meta;
}

/** Back to the built-in default: removes the metadata and the bytes together. */
export async function clearEventImage(slot: EventImageSlot): Promise<void> {
  await runWrite([
    ["HDEL", EVENT_IMAGES_KEY, slot],
    ["HDEL", EVENT_IMAGES_DATA_KEY, slot],
  ]);
}

function parseMeta(raw: unknown): EventImageMeta | null {
  if (typeof raw !== "string") return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (typeof m !== "object" || m === null) return null;
    if (m.type !== "image/png" && m.type !== "image/jpeg" && m.type !== "image/webp") return null;
    if (typeof m.bytes !== "number" || typeof m.w !== "number" || typeof m.h !== "number") return null;
    if (typeof m.etag !== "string" || !/^[0-9a-f]{16}$/.test(m.etag)) return null;
    return { type: m.type, bytes: m.bytes, w: m.w, h: m.h, etag: m.etag };
  } catch {
    return null;
  }
}

/** Upstash returns HGETALL as a flat [field, value, ...] array. */
function pairs(result: unknown): [string, unknown][] {
  if (!Array.isArray(result)) return [];
  const out: [string, unknown][] = [];
  for (let i = 0; i + 1 < result.length; i += 2) out.push([String(result[i]), result[i + 1]]);
  return out;
}

/** PUBLIC. Metadata only — one HGETALL on the small hash, never the bytes.
 *  THROWS on a read error; the page-level callers decide to fall back to the
 *  defaults (fail open), the image routes answer 503. */
export async function getEventImagesMeta(): Promise<EventImagesMeta> {
  const [res] = await upstashPipeline([["HGETALL", EVENT_IMAGES_KEY]]);
  if (res!.error) throw new Error(`Upstash HGETALL failed: ${res!.error}`);
  const out: EventImagesMeta = {};
  for (const [slot, raw] of pairs(res!.result)) {
    if (!isEventImageSlot(slot)) continue;
    const meta = parseMeta(raw);
    if (meta) out[slot] = meta;
  }
  return out;
}

/** The image routes' one read of the bytes: a single HGET. */
export async function getEventImageData(slot: EventImageSlot): Promise<string | null> {
  const [res] = await upstashPipeline([["HGET", EVENT_IMAGES_DATA_KEY, slot]]);
  if (res!.error) throw new Error(`Upstash HGET failed: ${res!.error}`);
  return typeof res!.result === "string" ? res!.result : null;
}

/** The archive section, or null when no image is stored (so an archive from
 *  a box with the defaults carries no `eventImages` key at all). */
export async function exportEventImages(): Promise<EventImagesBundle | null> {
  const [res] = await upstashPipeline([["HGETALL", EVENT_IMAGES_DATA_KEY]]);
  if (res!.error) throw new Error(`Upstash HGETALL failed: ${res!.error}`);
  const out: EventImagesBundle = {};
  for (const [slot, data] of pairs(res!.result)) {
    if (isEventImageSlot(slot) && typeof data === "string") out[slot] = { data };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Validates every image in an archive section. Throws on the first bad one
 *  and touches nothing — the event import calls it before anything
 *  destructive runs. */
export function validateEventImagesBundle(bundle: EventImagesBundle): Map<EventImageSlot, { bytes: Buffer; meta: EventImageMeta }> {
  const out = new Map<EventImageSlot, { bytes: Buffer; meta: EventImageMeta }>();
  for (const slot of EVENT_IMAGE_SLOTS) {
    const entry = bundle[slot];
    if (entry) out.set(slot, validateEventImage(slot, entry));
  }
  return out;
}

/** Writes an archive's images, every slot in one pipeline, after validating
 *  all of them. A slot the archive does not carry is left as it is — the
 *  same rule as an absent tagline or location. */
export async function importEventImages(bundle: EventImagesBundle): Promise<EventImagesMeta> {
  const validated = validateEventImagesBundle(bundle);
  const commands: (string | number)[][] = [];
  const out: EventImagesMeta = {};
  for (const [slot, { bytes, meta }] of validated) {
    commands.push(...writeCommands(slot, bytes, meta));
    out[slot] = meta;
  }
  if (commands.length > 0) await runWrite(commands);
  return out;
}
