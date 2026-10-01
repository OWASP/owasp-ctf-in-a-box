// The projector header (#543): the event's own logo beside its name (P1) and
// the scoring-window clock (P2). Static render, like display-board.size.test.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: () => {} }) }));

const { default: DisplayBoard } = await import("@/components/display-board");

const rows = [{ key: "a", rank: 1, name: "Byte Me", points: 2108 }];
const header = (html: string) => html.slice(0, html.indexOf("Byte Me"));

function render(props: Partial<Parameters<typeof DisplayBoard>[0]> = {}) {
  return renderToStaticMarkup(<DisplayBoard rows={rows} eventName="Red Team Space CTF" phaseLabel="live" {...props} />);
}

describe("DisplayBoard header — event logo (P1)", () => {
  it("shows the uploaded logo beside the name, sized for the wall", () => {
    const h = header(render({ eventLogo: { src: "/api/event/logo?v=0123456789abcdef", w: 482, h: 603 } }));
    const img = h.match(/<img[^>]*>/)?.[0] ?? "";
    expect(img).toContain('src="/api/event/logo?v=0123456789abcdef"');
    expect(img).toContain('alt="Red Team Space CTF logo"');
    expect(img).toContain("h-[6vh]");
    expect(img).toContain("max-w-[20vw]");
    expect(img).toContain("object-contain");
    expect(h).toContain("Red Team Space CTF");
  });

  it("is the name alone when no logo is set", () => {
    const h = header(render());
    expect(h).not.toMatch(/<img/);
    expect(h).toContain("Red Team Space CTF");
  });
});

describe("DisplayBoard header — scoring clock (P2)", () => {
  it("says not launched when no scoring start is set", () => {
    expect(header(render({ scoringStartsAt: null, scoringEndsAt: null }))).toContain("not launched");
  });

  it("counts down to a start that is still ahead", () => {
    const far = new Date(Date.now() + 5 * 86_400_000).toISOString();
    expect(header(render({ scoringStartsAt: far, scoringEndsAt: null }))).toMatch(/starts in \d+d \d{2}h/);
  });

  it("counts down to the end while live", () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    expect(header(render({ scoringStartsAt: past, scoringEndsAt: soon }))).toMatch(/ends in \d{2}:\d{2}:\d{2}/);
  });

  it("uses tabular figures so the ticking digits do not jitter", () => {
    const html = header(render({ scoringStartsAt: null, scoringEndsAt: null }));
    expect(html).toMatch(/<span[^>]*class="[^"]*tabular-nums[^"]*"[^>]*>not launched</);
  });
});
