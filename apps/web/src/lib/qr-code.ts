// The projector board's QR code of the event URL (#592), encoded HERE on the
// server: no third-party QR service, no client-side fetch, nothing about the
// viewer sent anywhere. `qrcode-generator` is encoding only (no I/O, no
// dependencies) and pinned exactly. The output is one SVG path of unit
// squares, rendered as a React <path d> — never an SVG string injected as
// markup — so the encoded text can never become part of the page's HTML.

import "server-only";
import qrcode from "qrcode-generator";

/** The light border around the code, in modules. The QR spec asks for four,
 *  and a phone camera needs it to find the code's edge. */
const QUIET = 4;

export type QrCode = {
  /** Width and height in modules, quiet zone included: the SVG viewBox. */
  size: number;
  /** One dark module per `M{x} {y}h1v1h-1z`, offset by the quiet zone. */
  path: string;
  quiet: number;
};

/** `text` as a QR code at error correction M (15% damage tolerated: enough
 *  for a projector's glare without growing the code past what a room can
 *  scan), at the smallest version that fits. */
export function qrCode(text: string): QrCode {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
  }
  return { size: n + 2 * QUIET, path, quiet: QUIET };
}

/** The projector board's QR code (#592): the event's own address, encoded,
 *  or null. On unless the organizer turned it off; settings that could not be
 *  read leave it on, like any cosmetic display default. `eventUrl` is
 *  BETTER_AUTH_URL, which compose sets from the event's EVENT_URL; without a
 *  valid http(s) one there is no code, since guessing the address from the
 *  request could point the room somewhere wrong. */
export function boardQr(
  settings: { displayQr: boolean } | null,
  eventUrl: string | undefined,
): (QrCode & { url: string }) | null {
  if (settings && !settings.displayQr) return null;
  let origin: string;
  try {
    const parsed = new URL(eventUrl ?? "");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    origin = parsed.origin;
  } catch {
    return null;
  }
  return { ...qrCode(origin), url: origin };
}
