// The phase line — the redesign's signature element, which until now had
// ZERO direct coverage (the landing suites only rendered it incidentally,
// always in the dateless-live state). These pins are the strip's contract:
// which phase resolves from which settings, which stops render, where the
// "now" chip sits, and that a settings failure renders NOTHING rather than
// a wrong answer.
//
// PhaseLine is an async Server Component: it is awaited and its element
// rendered — mounting it as JSX inside renderToStaticMarkup suspends.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  getAdminSettings: vi.fn(),
}));
vi.mock("@/lib/admin-store", () => ({ getAdminSettings: mocks.getAdminSettings }));

import PhaseLine, { resolvePhase } from "@/components/phase-line";

const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function render(settings: Record<string, unknown>): Promise<string> {
  mocks.getAdminSettings.mockResolvedValue(settings);
  return renderToStaticMarkup(await PhaseLine());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolvePhase", () => {
  // #464: no scoring start = not launched — the pre-launch lobby.
  it("is registration on a dateless, unpaused event (not launched)", async () => {
    mocks.getAdminSettings.mockResolvedValue({});
    expect((await resolvePhase())?.phase).toBe("registration");
  });

  it("is live once the scoring start has passed", async () => {
    mocks.getAdminSettings.mockResolvedValue({ scoringStartsAt: iso(-HOUR) });
    expect((await resolvePhase())?.phase).toBe("live");
  });

  it("is registration before the scoring open", async () => {
    mocks.getAdminSettings.mockResolvedValue({ scoringStartsAt: iso(HOUR) });
    expect((await resolvePhase())?.phase).toBe("registration");
  });

  it("is results after the scoring close, even while paused", async () => {
    mocks.getAdminSettings.mockResolvedValue({ scoringEndsAt: iso(-HOUR), paused: true });
    expect((await resolvePhase())?.phase).toBe("results");
  });

  it("is frozen under a manual pause mid-event", async () => {
    mocks.getAdminSettings.mockResolvedValue({ paused: true });
    expect((await resolvePhase())?.phase).toBe("frozen");
  });

  it("returns null when the settings read throws — never a guess", async () => {
    mocks.getAdminSettings.mockRejectedValue(new Error("redis blinked"));
    expect(await resolvePhase()).toBeNull();
  });
});

describe("PhaseLine", () => {
  it("marks the live stop with the now chip and keeps the frozen stop off the line", async () => {
    const html = await render({ scoringStartsAt: iso(-HOUR), scoringEndsAt: iso(HOUR) });
    expect(html).toContain('aria-label="Event phase: live"');
    expect(html).toContain("registration");
    expect(html).toContain("live");
    expect(html).toContain("results");
    // The HEAD marker is a chip saying "now", not the old "◀ now" glyph.
    expect(html).toContain(">now<");
    expect(html).not.toContain("◀");
    // A never-frozen event shows no frozen stop.
    expect(html).not.toContain("frozen");
  });

  it("inserts the frozen stop only while actually frozen", async () => {
    const html = await render({ paused: true });
    expect(html).toContain('aria-label="Event phase: frozen"');
    expect(html).toContain("frozen");
  });

  it("states the current phase's boundary time, pinned to UTC", async () => {
    // The start sits firmly in the past and the end firmly in the future —
    // a start of "today at 10:00" made this test phase-dependent on the
    // wall clock of the machine running it.
    const html = await render({
      scoringStartsAt: "2020-01-01T00:00:00.000Z",
      scoringEndsAt: "2099-08-24T18:00:00.000Z",
    });
    // Live now; the actionable boundary is the close, labeled honestly.
    expect(html).toMatch(/until Aug 24, 6:00 PM UTC/);
  });

  it("promises nothing for a manual freeze — no boundary line", async () => {
    const html = await render({ paused: true, scoringEndsAt: "2099-08-24T18:00:00.000Z" });
    expect(html).not.toContain("until");
    expect(html).not.toContain("UTC");
  });

  it("renders nothing at all when settings are unreadable", async () => {
    mocks.getAdminSettings.mockRejectedValue(new Error("redis blinked"));
    expect(renderToStaticMarkup(await PhaseLine())).toBe("");
  });
});
