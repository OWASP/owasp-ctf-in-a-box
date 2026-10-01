// Minimal SYNTHETIC image headers for the structural parsers in
// image-sniff.ts — signature plus the one chunk or marker each format's
// dimensions live in. Not real, decodable images. `padTo` grows a fixture to
// an exact byte size without touching the header the parser reads.

export function pngFixture(w: number, h: number, padTo = 24): Buffer {
  const buf = Buffer.alloc(Math.max(24, padTo));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

export function jpegFixture(w: number, h: number): Buffer {
  const buf = Buffer.alloc(15);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xc0;
  buf.writeUInt16BE(11, 4);
  buf[6] = 8;
  buf.writeUInt16BE(h, 7);
  buf.writeUInt16BE(w, 9);
  buf[11] = 1;
  buf[12] = 1;
  buf[13] = 0x11;
  buf[14] = 0;
  return buf;
}

export function webpLossyFixture(w: number, h: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8 ", 12, "ascii");
  buf.writeUInt32LE(buf.length - 20, 16);
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(w & 0x3fff, 26);
  buf.writeUInt16LE(h & 0x3fff, 28);
  return buf;
}

export const b64 = (buf: Buffer): string => buf.toString("base64");
