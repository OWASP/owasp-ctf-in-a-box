// #592: a QR code of the event URL on the projector board, so anyone in the
// room can join from a phone. Static render: the board's refresh is an effect.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: () => {} }) }));

const { default: DisplayBoard } = await import("@/components/display-board");

const QR = { size: 29, path: "M4 4h1v1h-1zM5 4h1v1h-1z", url: "https://ctf.example.org" };
const rows = [{ key: "a", rank: 1, name: "Alpha", points: 100 }];

function render(qr?: typeof QR | null) {
  return renderToStaticMarkup(<DisplayBoard rows={rows} eventName="Fixture CTF" phaseLabel={null} sponsors={[]} qr={qr} />);
}

describe("DisplayBoard QR code", () => {
  it("draws the code as an inline SVG path, with the URL as text under it", () => {
    const html = render(QR);
    expect(html).toContain('viewBox="0 0 29 29"');
    expect(html).toContain('d="M4 4h1v1h-1zM5 4h1v1h-1z"');
    expect(html).toContain(">https://ctf.example.org<");
    expect(html).toMatch(/aria-label="QR code: https:\/\/ctf\.example\.org"/);
  });

  // Outside the standings list, so it can never cover a row.
  it("sits after the standings, not inside them", () => {
    const html = render(QR);
    expect(html.indexOf("</ol>")).toBeLessThan(html.indexOf('viewBox="0 0 29 29"'));
  });

  it("draws nothing when the organizer turned it off (no qr)", () => {
    expect(render(null)).not.toContain("viewBox");
    expect(render()).not.toContain("ctf.example.org");
  });
});
