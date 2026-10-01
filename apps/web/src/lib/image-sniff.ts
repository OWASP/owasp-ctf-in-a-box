// Raster image sniffing shared by every store that accepts an uploaded image
// (sponsor logos #405, the event logo and favicon #529). Pure and
// dependency-free: each store keeps its own size caps and error messages and
// calls in here only for "what are these bytes, really".
//
// SECURITY INVARIANT, for every caller: the declared MIME type and any
// filename are ignored for the accept/reject decision — only the DECODED
// bytes' own magic number and structure decide. Raster only. SVG has its own
// verdict rather than falling through to "unknown", because an SVG served
// from our own origin executes its embedded script the moment someone opens
// the image URL directly — nothing stops a browser address bar from doing
// that, so "served from an `<img>` tag" is not a mitigation.

export type RasterMime = "image/png" | "image/webp" | "image/jpeg";

export type SniffResult =
  | { ok: true; type: RasterMime; w: number; h: number }
  /** `png`/`webp`/`jpeg`: the magic matched but the structure did not.
   *  `svg`: an SVG, refused on purpose. `unknown`: none of the above. */
  | { ok: false; reason: "png" | "webp" | "jpeg" | "svg" | "unknown" };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

// `Buffer.from(str, "base64")` is lenient — it silently drops characters
// outside the base64 alphabet rather than throwing, so a malformed string
// decoded fine and only failed later (if at all) on the magic-byte sniff.
// This rejects it explicitly, before any decoding is attempted.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The decoded bytes, or null when `data` is not canonical padded base64. */
export function decodeStrictBase64(data: string): Buffer | null {
  if (!BASE64_RE.test(data) || data.length % 4 !== 0) return null;
  return Buffer.from(data, "base64");
}

/** What the bytes are. `declaredType` only ever sharpens a refusal (an
 *  organizer who picked an SVG hears "SVG" rather than "unknown"); it never
 *  makes anything acceptable. */
export function sniffRasterImage(bytes: Buffer, declaredType?: string): SniffResult {
  if (bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    const dims = parsePngDimensions(bytes);
    return dims ? { ok: true, type: "image/png", ...dims } : { ok: false, reason: "png" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const dims = parseWebpDimensions(bytes);
    return dims ? { ok: true, type: "image/webp", ...dims } : { ok: false, reason: "webp" };
  }
  if (bytes.subarray(0, 3).equals(JPEG_MAGIC)) {
    const dims = parseJpegDimensions(bytes);
    return dims ? { ok: true, type: "image/jpeg", ...dims } : { ok: false, reason: "jpeg" };
  }
  // Cheap heuristic sniff for the one format organizers are likeliest to
  // reach for by habit: an SVG has no fixed magic number, but a real one
  // always carries its tag within the first kilobyte.
  if (/<svg[\s>]/i.test(bytes.subarray(0, 1024).toString("latin1")) || declaredType === "image/svg+xml") {
    return { ok: false, reason: "svg" };
  }
  return { ok: false, reason: "unknown" };
}

/** PNG's IHDR is always the first chunk, immediately after the 8-byte
 *  signature: 4-byte length (must be 13), 4-byte type "IHDR", then 4-byte
 *  width and 4-byte height, both big-endian. No image library needed — this
 *  doubles as a structural validity check, since a file that merely starts
 *  with the PNG magic but is not shaped like this is not a PNG a browser
 *  could decode either. */
function parsePngDimensions(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(8) !== 13) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  if (w === 0 || h === 0) return null;
  return { w, h };
}

/** WebP's dimensions live in whichever of the three chunk kinds follows the
 *  12-byte RIFF/WEBP header, each with its own bit-packed layout (see the
 *  WebP container spec): "VP8 " (lossy), "VP8L" (lossless) or "VP8X"
 *  (extended, e.g. animated). */
function parseWebpDimensions(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length < 30) return null;
  const fourCC = bytes.toString("ascii", 12, 16);
  if (fourCC === "VP8 ") {
    // 3-byte frame tag, then a 3-byte start code that must read 0x9d 0x01
    // 0x2a, then two little-endian 16-bit fields whose low 14 bits are
    // width/height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const w = bytes.readUInt16LE(26) & 0x3fff;
    const h = bytes.readUInt16LE(28) & 0x3fff;
    if (w === 0 || h === 0) return null;
    return { w, h };
  }
  if (fourCC === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    const w = 1 + (((b1 & 0x3f) << 8) | b0);
    const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    if (w === 0 || h === 0) return null;
    return { w, h };
  }
  if (fourCC === "VP8X") {
    const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    if (w === 0 || h === 0) return null;
    return { w, h };
  }
  return null;
}

/** JPEG has no fixed-offset dimension field — after the FFD8 SOI it's a
 *  chain of FF<marker><length><payload> segments (length counts itself but
 *  not the FF/marker byte), and the dimensions live in whichever
 *  Start-Of-Frame marker (FFC0-FFCF, excluding the DHT/JPG/DAC reserved
 *  bytes C4/C8/CC) turns up first. Walk the chain until one does, or the
 *  bytes run out — bounded by `bytes.length`, which every caller's size cap already
 *  caps, so this can't loop past a well-formed length field. */
function parseJpegDimensions(bytes: Buffer): { w: number; h: number } | null {
  let offset = 2; // past the FFD8 SOI the magic check already matched
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Standalone markers carry no length: SOI, EOI, TEM, and the RST0-RST7
    // restart markers.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    // `length` counts itself, so a segment's own declared end must reach at
    // least 2; a segment claiming to run past the buffer is malformed too.
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // Per spec (ITU-T81), Lf = 8 + 3*Nf: the 2 length bytes, precision (1),
      // height (2), width (2), a component count Nf (1), then a 3-byte record
      // per component — at least one. length===8 alone (Nf absent/garbage)
      // is structurally too short to be a real SOF even though the buffer
      // has enough bytes after it to read width/height; requiring the exact
      // equation, not just a floor, is what actually rejects it.
      if (length < 11) return null;
      const components = bytes[offset + 9]!;
      if (length !== 8 + 3 * components) return null;
      const h = bytes.readUInt16BE(offset + 5);
      const w = bytes.readUInt16BE(offset + 7);
      if (w === 0 || h === 0) return null;
      return { w, h };
    }
    offset += 2 + length;
  }
  return null;
}
