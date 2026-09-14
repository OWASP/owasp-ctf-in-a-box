// @testing-library/react is not a dependency of this repo and must not be
// added just for this test — same constraint as admin-classic-controls.test.tsx
// and admin-quiz-controls.test.tsx. This component has no mount-time fetch of
// its own list (unlike those two: it has no list, only an import textarea and
// an export button), so `renderToStaticMarkup` sees the whole import panel
// exactly as an organizer would on first paint.
//
// The double-confirmation ConfirmModals are gated behind `useState`
// (`importStage`), so — same as the delete confirmation on the sibling
// panels — they never appear in a plain static render. Their copy is proven
// instead through the exported pure functions (`importFirstWarning`,
// `importReplaceConfirm`) the component wires into its JSX, mirroring how
// `challengeDeleteConfirm`/`questionDeleteConfirm` are proven on the siblings.
//
// The import button's gating (`canImport`, driven by `parseEventBundle`) IS
// observable in a static render, because — unlike the siblings' `importText`,
// which only ever starts empty — this component accepts `initialImportText`
// as a test/first-paint seed (mirroring `initialChallenges`/
// `initialQuestions`), so a test can render with the textarea already "pasted
// into" and assert the button's disabled attribute either way.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseEventBundle, serializeEventBundle, type EventBundle } from "@/lib/event-io";
import AdminEventControls, {
  IMPORT_CONFIRM_PHRASE,
  describeEventError,
  formatImportSummary,
  importFirstWarning,
  importReplaceConfirm,
} from "@/components/admin-event-controls";

// version: 1 deliberately — a legacy bundle predating secureDevTargets/
// EVENT_BUNDLE_VERSION 2, still accepted (event-io.ts's EVENT_BUNDLE_MIN_VERSION).
const validBundle: EventBundle = {
  version: 1,
  kind: "archive",
  event: { name: "Demo CTF", theme: "web", dates: "2026", location: "online", ctfStartsAt: null },
  settings: { hintCost: 50, teamMaxMembers: 4 },
  quiz: {
    version: 1,
    questions: [
      {
        id: "q-one-ab12cd",
        prompt: "P?",
        type: "single",
        choices: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        points: 10,
        order: 0,
        correct: ["a"],
      },
    ],
  },
};

const validText = serializeEventBundle(validBundle);

describe("AdminEventControls", () => {
  it("renders the export control", () => {
    const html = renderToStaticMarkup(<AdminEventControls />);
    expect(html).toMatch(/export/i);
  });

  it("renders the import controls: file input, textarea, import button", () => {
    const html = renderToStaticMarkup(<AdminEventControls />);
    expect(html).toContain('type="file"');
    expect(html).toMatch(/import/i);
  });

  // (a) the import button is disabled until pasted text passes
  // parseEventBundle, enabled when valid.
  it("disables the import button when the textarea is empty", () => {
    const html = renderToStaticMarkup(<AdminEventControls initialImportText="" />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Import[\s\S]*?<\/button>/);
  });

  it("disables the import button when the pasted text fails parseEventBundle", () => {
    expect(parseEventBundle("{not json").ok).toBe(false);
    const html = renderToStaticMarkup(<AdminEventControls initialImportText="{not json" />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Import[\s\S]*?<\/button>/);
    expect(html).toMatch(/invalid json/i);
  });

  it("enables the import button once the pasted text passes parseEventBundle", () => {
    expect(parseEventBundle(validText).ok).toBe(true);
    const html = renderToStaticMarkup(<AdminEventControls initialImportText={validText} />);
    // The Import bundle button must NOT carry the disabled="" attribute
    // React's static renderer emits (a Tailwind `disabled:` variant class is
    // still present either way, so matching on the literal HTML attribute —
    // not the substring "disabled" — is what actually distinguishes the two
    // states here).
    const buttonMatch = html.match(/<button[^>]*>Import bundle<\/button>/);
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch?.[0]).not.toMatch(/disabled=""/);
  });

  it("shows client-side validation errors for an invalid pasted bundle", () => {
    // `{"version":1}` satisfies the version check (1 is still an accepted
    // legacy version — EVENT_BUNDLE_MIN_VERSION through EVENT_BUNDLE_VERSION,
    // see event-io.ts) but fails every other top-level check in
    // parseEventBundle (event-io.ts):
    // kind, event, settings are all missing, and neither classic nor quiz is
    // present. That last failure emits the fragment "carries no modules" —
    // asserted here specifically because it appears ONLY inside a rendered
    // <li> from `clientErrors`, never in this component's always-on
    // boilerplate copy (unlike "kind"/"archive"/"event"/"settings", which the
    // panel's own static prose already contains regardless of whether any
    // error list renders at all — the previous version of this assertion
    // passed unconditionally for exactly that reason).
    const parsed = parseEventBundle('{"version":1}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.errors.some((e) => e.message.includes("carries no modules"))).toBe(true);

    const html = renderToStaticMarkup(<AdminEventControls initialImportText='{"version":1}' />);
    expect(html).toMatch(/carries no modules/i);
  });
});

// (b) a destructive-replace confirmation is required before the POST fires.
// Proven through the exported pure copy-builders the component's two-stage
// `importStage` state machine renders into its ConfirmModals — the same
// reasoning `challengeDeleteConfirm`/`questionDeleteConfirm` document on the
// sibling panels: `useState`-gated JSX cannot be reached by
// `renderToStaticMarkup`, so the copy that GATES the destructive action is
// proven directly.
describe("the double confirmation before an import POST fires", () => {
  it("the first-step warning names exactly what gets replaced/wiped", () => {
    const warn = importFirstWarning();
    expect(warn.body).toMatch(/jeopardy/i);
    expect(warn.body).toMatch(/quiz/i);
    // #250: the ai catalogue is replaced too, and the copy has to say so.
    expect(warn.body).toMatch(/\bAI\b/);
    expect(warn.body).toMatch(/team/i);
    expect(warn.body).toMatch(/solve/i);
  });

  it("the second-step confirmation and the panel's own prose name AI alongside Jeopardy and Quiz", () => {
    expect(importReplaceConfirm().body).toMatch(/\bAI\b/);
    const html = renderToStaticMarkup(<AdminEventControls />);
    expect(html).toMatch(/Jeopardy, Quiz and AI/);
  });

  it("the second-step confirmation requires typing a non-empty phrase", () => {
    const confirm = importReplaceConfirm();
    expect(confirm.requireType).toBe(IMPORT_CONFIRM_PHRASE);
    expect(confirm.requireType.length).toBeGreaterThan(0);
    expect(confirm.body).toMatch(/replace|wipe/i);
  });

  it("the second-step phrase is never empty — the same ConfirmModal guard the siblings rely on", () => {
    // ConfirmModal treats an empty requireType as "no confirmation required"
    // (see confirm-modal.tsx's own comment). A destructive whole-event
    // replace must never be reachable that way.
    expect(IMPORT_CONFIRM_PHRASE.trim().length).toBeGreaterThan(0);
  });
});

describe("formatImportSummary", () => {
  it("names each module's created/updated counts when both are present", () => {
    const text = formatImportSummary({ classic: { created: 2, updated: 1 }, quiz: { created: 0, updated: 3 } });
    expect(text).toMatch(/jeopardy/i);
    expect(text).toMatch(/quiz/i);
    expect(text).toContain("2");
    expect(text).toContain("3");
  });

  it("names only the module actually present in the summary", () => {
    const text = formatImportSummary({ quiz: { created: 1, updated: 0 } });
    expect(text.toLowerCase()).not.toContain("jeopardy");
    expect(text).not.toMatch(/\bAI\b/);
    expect(text).toMatch(/quiz/i);
  });

  it("names the ai section's counts when the bundle carried one (#250)", () => {
    const text = formatImportSummary({ ai: { created: 4, updated: 1 } });
    expect(text).toMatch(/\bAI\b: 4 created, 1 updated/);
    expect(text.toLowerCase()).not.toContain("jeopardy");
  });
});

describe("describeEventError", () => {
  it("surfaces a 400 validation error as the server's own message", () => {
    expect(describeEventError(400, "bad bundle")).toBe("bad bundle");
  });

  it("surfaces a 409 live-event refusal distinctly", () => {
    const msg = describeEventError(409, "Refusing to import — the event is live. Pause scoring first.");
    expect(msg).toMatch(/live/i);
  });

  it("surfaces a 503 infrastructure failure distinctly from a validation error", () => {
    const msg = describeEventError(503, "store write failed");
    expect(msg).not.toBe("store write failed");
    expect(msg).toMatch(/unavailable/i);
  });
});
