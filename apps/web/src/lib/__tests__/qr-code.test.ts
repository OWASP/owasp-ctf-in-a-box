// #592: the projector board's QR code, encoded on the server into one SVG
// path (no third-party service, no client fetch, no injected markup).
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { qrCode } from "@/lib/qr-code";

/** The module grid back out of the path: each "M{x} {y}h1v1h-1z" is one dark
 *  module, offset by the quiet zone. */
function grid(q: { size: number; path: string; quiet: number }): boolean[][] {
  const n = q.size - 2 * q.quiet;
  const g = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  for (const m of q.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) g[+m[2] - q.quiet][+m[1] - q.quiet] = true;
  return g;
}

describe("qrCode", () => {
  it("encodes the URL with the three finder patterns in their corners", () => {
    const q = qrCode("https://ctf.example.org");
    const g = grid(q);
    const n = g.length;
    expect(n).toBeGreaterThanOrEqual(21);
    // A finder pattern: a dark 7×7 ring, light ring inside, dark 3×3 centre.
    const finder = (r0: number, c0: number) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          expect(g[r0 + r][c0 + c], `finder at ${r0},${c0} cell ${r},${c}`).toBe(ring || core);
        }
      }
    };
    finder(0, 0);
    finder(0, n - 7);
    finder(n - 7, 0);
  });

  it("keeps a four-module quiet zone, which phones need to lock on", () => {
    const q = qrCode("https://ctf.example.org");
    expect(q.quiet).toBe(4);
    const coords = [...q.path.matchAll(/M(\d+) (\d+)/g)].flatMap((m) => [+m[1], +m[2]]);
    expect(Math.min(...coords)).toBe(4);
    expect(Math.max(...coords)).toBe(q.size - 5);
  });

  it("is deterministic and changes with the text", () => {
    expect(qrCode("https://a.example").path).toBe(qrCode("https://a.example").path);
    expect(qrCode("https://a.example").path).not.toBe(qrCode("https://b.example").path);
  });

  it("is a path of unit squares only, nothing that could carry markup", () => {
    expect(qrCode("https://ctf.example.org/<script>").path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  });
});

describe("boardQr", () => {
  it("encodes the event's origin when the setting is on", async () => {
    const { boardQr } = await import("@/lib/qr-code");
    const q = boardQr({ displayQr: true }, "https://ctf.example.org/");
    expect(q?.url).toBe("https://ctf.example.org");
    expect(q?.path).toBe(qrCode("https://ctf.example.org").path);
  });

  it("is on by default when the settings could not be read", async () => {
    const { boardQr } = await import("@/lib/qr-code");
    expect(boardQr(null, "https://ctf.example.org")?.url).toBe("https://ctf.example.org");
  });

  it("is off when the organizer turned it off", async () => {
    const { boardQr } = await import("@/lib/qr-code");
    expect(boardQr({ displayQr: false }, "https://ctf.example.org")).toBeNull();
  });

  // Without a configured address the box would have to guess one from the
  // request; a code pointing at the wrong place is worse than none.
  it("is null when the event URL is unset or not http(s)", async () => {
    const { boardQr } = await import("@/lib/qr-code");
    expect(boardQr({ displayQr: true }, undefined)).toBeNull();
    expect(boardQr({ displayQr: true }, "not a url")).toBeNull();
    expect(boardQr({ displayQr: true }, "javascript:alert(1)")).toBeNull();
  });
});
