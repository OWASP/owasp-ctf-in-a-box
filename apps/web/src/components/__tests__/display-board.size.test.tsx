// Projector-board logo sizing. Sibling of sponsor-strip.size.test.tsx: the
// display board honours the same organizer setting (`sponsorLogoSize`) the
// landing strip does, but at projector scale — the original fixed 2.2vh read
// as an illegible fleck from the back of a room, which is the whole point of
// this surface.
//
// Static render only, like sponsor-boundary.test.tsx: none of these
// assertions need interactivity, and the board's 30s refresh is an effect.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: () => {} }) }));

const { default: DisplayBoard } = await import("@/components/display-board");

const SPONSOR_NAME = "Zzyzx Security Labs";
const SPONSOR_LOGO_SRC = "/api/sponsors/logo/zzyzx-sec-ab12cd";

function render(logoSize?: "sm" | "md" | "lg", logoSrc: string | null = SPONSOR_LOGO_SRC) {
  return renderToStaticMarkup(
    <DisplayBoard
      rows={[]}
      eventName="Fixture CTF"
      phaseLabel={null}
      logoSize={logoSize}
      sponsors={[{ key: "zzyzx", name: SPONSOR_NAME, logoSrc, w: 40, h: 40, logoType: "image/png" }]}
    />,
  );
}

describe("DisplayBoard — organizer-set sponsor logo size", () => {
  it("defaults to the medium preset when the prop is absent", () => {
    expect(render()).toContain("h-[5.5vh]");
  });

  it("renders the small preset", () => {
    expect(render("sm")).toContain("h-[4vh]");
  });

  it("renders the large preset", () => {
    expect(render("lg")).toContain("h-[7vh]");
  });

  // The pre-fix size. Pinning its absence is what keeps a later refactor from
  // quietly reinstating the fleck this change exists to remove.
  it("never renders the old fixed 2.2vh logo size", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      expect(render(size)).not.toContain("h-[2.2vh]");
    }
  });

  it("scales the no-logo fallback name with the same setting", () => {
    const small = render("sm", null);
    const large = render("lg", null);
    expect(small).toContain(SPONSOR_NAME);
    expect(large).toContain(SPONSOR_NAME);
    expect(small).not.toEqual(large);
  });
});
