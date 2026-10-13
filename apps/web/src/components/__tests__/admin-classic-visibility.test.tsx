// The admin half of a Jeopardy challenge's visibility: the form's "Visible to
// contestants" switch, the status chip on each row, and the payloads and
// export carrying the field — a reorder or an export must never quietly
// publish a hidden challenge.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseBundle } from "@/lib/classic-io";
import type { AdminChallenge, Challenge } from "@/lib/classic-store";
import AdminClassicControls, {
  ChallengeForm,
  ClassicTimeZoneContext,
  statusChip,
  draftFromChallenge,
  editorFromChallenge,
  emptyDraft,
  exportBundleFrom,
  payloadFromEditor,
  payloadFromRow,
} from "@/components/admin-classic-controls";

const noop = () => {};
const live: Challenge = { id: "live-ab12cd", title: "Live one", category: "Web", description: "", points: 10, order: 1 };
const off: Challenge = { id: "off-ab12cd", title: "Off one", category: "Web", description: "", points: 20, order: 2, enabled: false };
const row = (c: Challenge): AdminChallenge => ({ challenge: c, flag: "CTF{x}", hint: null });

describe("the draft and its payloads", () => {
  it("starts a new challenge visible, as before the switch existed", () => {
    expect(emptyDraft("Web").enabled).toBe(true);
  });

  it("seeds the switch from the stored record", () => {
    expect(draftFromChallenge(row(live)).enabled).toBe(true);
    expect(draftFromChallenge(row(off)).enabled).toBe(false);
  });

  it("sends enabled:false only when switched off, so a live record stays byte-identical", () => {
    const editor = editorFromChallenge(row(live));
    expect("enabled" in payloadFromEditor(editor)).toBe(false);
    expect(payloadFromEditor({ ...editor, draft: { ...editor.draft, enabled: false } }).enabled).toBe(false);
  });

  it("carries enabled:false through a reorder, which must never publish a hidden challenge", () => {
    expect(payloadFromRow(row(off)).enabled).toBe(false);
    expect("enabled" in payloadFromRow(row(live))).toBe(false);
  });

  it("exports the field, stamps version 4, and the file parses", () => {
    const bundle = exportBundleFrom([row(live), row(off)], ["Web"]);
    expect(bundle.version).toBe(4);
    expect(bundle.challenges[1].enabled).toBe(false);
    expect("enabled" in bundle.challenges[0]).toBe(false);
    expect(parseBundle(JSON.stringify(bundle)).ok).toBe(true);
    expect(exportBundleFrom([row(live)], ["Web"]).version).toBe(2);
  });
});

describe("the form", () => {
  function renderForm(c: Challenge) {
    return renderToStaticMarkup(
      <ChallengeForm
        editor={editorFromChallenge(row(c))}
        categories={["Web"]}
        pending={false}
        error={null}
        flagRevealed={false}
        setFlagRevealed={noop}
        onChange={noop}
        onCancel={noop}
        onSubmit={noop}
      />,
    );
  }

  it("offers a Visible to contestants switch, on for a live challenge and off for a disabled one", () => {
    const on = renderForm(live);
    expect(on).toContain("Visible to contestants");
    expect(on).toMatch(/<input type="checkbox" aria-describedby="visible-help"[^>]*checked=""/);
    const offHtml = renderForm(off);
    expect(offHtml).toContain("Visible to contestants");
    expect(offHtml).not.toMatch(/<input type="checkbox" aria-describedby="visible-help"[^>]*checked=""/);
  });
});

describe("the status chip", () => {
  it("names each row Live or Disabled", () => {
    const html = renderToStaticMarkup(
      <AdminClassicControls
        initialLoaded
        pending={false}
        classicCooldownSecInput="5"
        setClassicCooldownSecInput={noop}
        commitNumber={noop}
        initialChallenges={[row(live), row(off)]}
        initialCategories={["Web"]}
      />,
    );
    expect(html).toMatch(/data-status="live"[^>]*>Live</);
    expect(html).toMatch(/data-status="disabled"[^>]*>Disabled</);
  });
});

describe("a scheduled release", () => {
  const FUTURE = "2099-10-08T13:00:00.000Z";
  const scheduled: Challenge = { ...off, id: "later-ab12cd", title: "Later one", releaseAt: FUTURE };

  it("seeds the draft from the stored schedule, and a passed one as plain live", () => {
    expect(draftFromChallenge(row(scheduled))).toMatchObject({ enabled: false, releaseAt: FUTURE });
    const passed = { ...scheduled, releaseAt: "2000-01-01T00:00:00.000Z" };
    expect(draftFromChallenge(row(passed))).toMatchObject({ enabled: true, releaseAt: "" });
    expect(emptyDraft("Web").releaseAt).toBe("");
  });

  it("sends the instant with enabled:false, and carries it through a reorder", () => {
    const editor = editorFromChallenge(row(scheduled));
    expect(payloadFromEditor(editor)).toMatchObject({ enabled: false, releaseAt: FUTURE });
    expect(payloadFromRow(row(scheduled))).toMatchObject({ enabled: false, releaseAt: FUTURE });
    expect("releaseAt" in payloadFromRow(row(live))).toBe(false);
  });

  it("exports the instant", () => {
    const bundle = exportBundleFrom([row(scheduled)], ["Web"]);
    expect(bundle.version).toBe(4);
    expect(bundle.challenges[0]).toMatchObject({ enabled: false, releaseAt: FUTURE });
    expect(parseBundle(JSON.stringify(bundle)).ok).toBe(true);
  });

  it("labels the chip with the release time on the event clock, its offset named", () => {
    expect(statusChip(scheduled, Date.parse("2099-01-01T00:00:00Z"), "America/Argentina/Buenos_Aires")).toEqual({
      kind: "scheduled",
      label: "Releases Oct 8, 10:00 GMT-3",
    });
    expect(statusChip(scheduled, Date.parse("2099-01-01T00:00:00Z"), "UTC").label).toBe("Releases Oct 8, 13:00 UTC");
  });

  it("shows the chip on the admin list, read on the event's time zone", () => {
    const html = renderToStaticMarkup(
      <AdminClassicControls
        initialLoaded
        pending={false}
        classicCooldownSecInput="5"
        setClassicCooldownSecInput={noop}
        commitNumber={noop}
        initialChallenges={[row(scheduled)]}
        initialCategories={["Web"]}
        timeZone="America/Argentina/Buenos_Aires"
      />,
    );
    expect(html).toMatch(/data-status="scheduled"[^>]*>Releases Oct 8, 10:00 GMT-3</);
  });

  it("offers a Release at field on the event clock, showing the UTC instant it stores", () => {
    const html = renderToStaticMarkup(
      <ClassicTimeZoneContext.Provider value="America/Argentina/Buenos_Aires">
        <ChallengeForm
          editor={editorFromChallenge(row(scheduled))}
          categories={["Web"]}
          pending={false}
          error={null}
          flagRevealed={false}
          setFlagRevealed={noop}
          onChange={noop}
          onCancel={noop}
          onSubmit={noop}
        />
      </ClassicTimeZoneContext.Provider>,
    );
    expect(html).toContain("Release at");
    expect(html).toMatch(/type="datetime-local"[^>]*value="2099-10-08T10:00"/);
    expect(html).toContain("2099-10-08T13:00:00.000Z");
    expect(html).toContain("GMT-3");
  });
});

describe("the editor's release time", () => {
  it("refuses a draft whose release time carries no zone, and accepts what the field produces", async () => {
    const { isDraftValid } = await import("@/components/admin-classic-controls");
    const { wallToInstant } = await import("@/lib/event-time");
    const draft = { ...draftFromChallenge(row(live)), flag: "CTF{x}" };
    expect(isDraftValid({ ...draft, enabled: false, releaseAt: "2099-10-08T10:00:00" }, ["Web"])).toBe(false);
    expect(isDraftValid({ ...draft, enabled: false, releaseAt: wallToInstant("2099-10-08T10:00", "America/Argentina/Buenos_Aires")! }, ["Web"])).toBe(true);
  });
});
