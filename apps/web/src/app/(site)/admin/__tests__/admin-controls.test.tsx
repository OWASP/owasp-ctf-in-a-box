// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. AdminControls is a "use client" component but
// has no effects that run during a plain render, so renderToStaticMarkup is
// enough to check markup — same pattern as team-card.test.tsx. Content gated
// behind useState (e.g. the confirm modal) never appears in this render, so
// we only assert on what's present in the initial static markup.
//
// The panel assertions below lean on the component rendering EVERY tab panel
// and hiding the inactive ones with `hidden`. If that ever regresses to
// `{active === id && <Tab/>}`, `panelFor` throws instead of quietly making
// these tests vacuous.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { AdminSettings } from "@/lib/admin-store";
import type { ResolvedModule } from "@/lib/modules";
import { panelFor } from "./panel-for";
import { HINT_COST, HINT_MIN_SOLVES, HINT_UNLOCK_AFTER_MIN } from "@/lib/hint-defaults";
import { QUIZ_MAX_ATTEMPTS, QUIZ_RETRY_AFTER_MIN } from "@/lib/quiz-defaults";
import { CLASSIC_COOLDOWN_SEC } from "@/lib/classic-defaults";
import { AI_COOLDOWN_SEC } from "@/lib/ai-defaults";
import AdminEventTab, { type AdminEventTabProps } from "@/app/(site)/admin/admin-event-tab";

// A plain, unrendered React element as the object shape both helpers below
// walk — `{$$typeof, type, props, ...}` — not the DOM; nothing here ever
// touches ReactDOMServer's output string.
type ReactEl = { type: unknown; props?: Record<string, unknown> };

/** Depth-first search through a React element tree that was never actually
 *  rendered/reconciled (see `captureTree` below) for the first element
 *  matching `predicate`. Needed because `renderToStaticMarkup`'s HTML string
 *  drops every event handler — a `name="x"` attribute survives serialization,
 *  an `onClick` closure does not — so proving what an `onClick` actually DOES
 *  requires holding the real element object, not its markup. */
function findElement(node: unknown, predicate: (el: ReactEl) => boolean): ReactEl | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!("type" in node)) return null;
  const el = node as ReactEl;
  if (predicate(el)) return el;
  return findElement(el.props?.children, predicate);
}

/** Calls a function component directly — same "call it, don't `<JSX/>` it"
 *  trick `admin-module-identity.binding.test.tsx` uses for `IdentityField` —
 *  from inside a throwaway `Probe` so its hooks (`AdminControls` has several)
 *  attach to a real fiber during `renderToStaticMarkup`, without needing
 *  @testing-library or a DOM. Returns the RAW element tree the component
 *  returns: nested component elements (e.g. `<AdminEventTab/>`) come back
 *  with their fully resolved props but are never themselves rendered. */
function captureTree<P>(Component: (props: P) => ReactElement | null, props: P): ReactElement {
  let captured: ReactElement | null = null;
  function Probe() {
    captured = Component(props);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured) throw new Error("Probe never captured the component's returned element");
  return captured;
}

// AdminControls now takes its modules as a prop (already resolved
// server-side), so it no longer reads the registry itself. The mock stays so
// this suite is never coupled to whatever `event.yaml` happens to enable for
// anything else that resolves `@/lib/modules` in this import graph.
const { enabledModules } = vi.hoisted(() => ({
  enabledModules: [
    {
      id: "secure-development",
      displayName: "Secure Development",
      description: "Find the vulnerability, patch it for real, ship the fix as a PR.",
      nav: { href: "/challenges", label: "Challenges" },
      targets: ["juice-shop"],
    },
    {
      id: "quiz",
      displayName: "Quiz",
      description: "Answer security questions for points.",
      targets: [],
    },
  ],
}));

// MODULE_TITLE_MAX/MODULE_BLURB_MAX live in @/lib/modules (client-safe — see
// that file's comment on why they aren't defined in admin-store.ts), so this
// full-module mock has to supply them too. `ALL_MODULE_IDS` and
// `moduleDefById` came with runtime enablement (issue #175): the panel builds
// its module toggle rows off the WHOLE registry, not the enabled subset, so
// it can offer a disabled module's switch at all.
vi.mock("@/lib/modules", () => ({
  enabledModules,
  ALL_MODULE_IDS: ["secure-development", "quiz", "classic"],
  moduleDefById: (id: string) =>
    ({
      "secure-development": { displayName: "Secure Development", description: "" },
      quiz: { displayName: "Quiz", description: "Answer security questions for points." },
      classic: { displayName: "Classic CTF", description: "" },
    })[id],
  MODULE_TITLE_MAX: 60,
  MODULE_BLURB_MAX: 200,
  // The ai panel's "Wiring the external site" drawer links the integrator
  // contract with this; a mock missing it fails the whole panel at import.
  DOCS_URL: "https://docs.example/",
}));

import AdminControls, { nextEventNameAfterSave } from "@/app/(site)/admin/admin-controls";
import { DEFAULT_EVENT_IDENTITY } from "@/lib/event-identity";

/** What the server hands down: registry defaults already merged with any
 *  organizer override (see lib/resolved-modules.ts). Note `title`/`blurb` —
 *  a ResolvedModule has no `displayName`, deliberately. */
const twoModules: readonly ResolvedModule[] = [
  {
    id: "secure-development",
    title: "Secure Development",
    blurb: "Find the vulnerability, patch it for real, ship the fix as a PR.",
    nav: { href: "/challenges", label: "Challenges" },
  },
  {
    id: "quiz",
    title: "Quiz",
    blurb: "Answer security questions for points.",
  },
];

const settings: AdminSettings = {
  paused: false,
  teamRegistrationOpen: true,
  hintsEnabled: null,
  hintCost: null,
  hintsMinSolves: null,
  hintsUnlockAfterMin: null,
  quizMaxAttempts: null,
  quizRetryAfterMin: null,
  classicCooldownSec: null,
  aiCooldownSec: null,
  teamMaxMembers: null,
  scoreCooldownMin: null,
  scoringStartsAt: null,
  scoringEndsAt: null,
  registrationStartsAt: null,
  registrationEndsAt: null,
  updatedBy: null,
  updatedAt: null,
  moduleOverrides: {},
  enabledModuleIds: null,
  eventIdentity: {},
  secureDevTargets: null,
};

describe("AdminControls tab shell", () => {
  it("renders one sidebar destination per enabled module plus the six control-plane destinations", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    expect(html).toContain('aria-label="Admin sections"');
    expect(html).toContain("Overview");
    expect(html).toContain("Event");
    expect(html).toContain("Admins");
    expect(html).toContain("Support");
    expect(html).toContain("Activity");
    expect(html).toContain("Insights");
    expect(html).toContain("Secure Development");
    expect(html).toContain("Quiz");
    // Overview + Event + Hints + Admins + Sponsors + Support + Activity +
    // Insights + the two modules. The eight control-plane destinations are
    // not modules, so all eight are present regardless of what the event
    // enables.
    expect(html.match(/href="\/admin\//g)?.length).toBe(10);
  });

  // Setup instructions are a registry contract (`ModuleDef.setup`), resolved
  // server-side and handed down as plain data. The shell renders them as the
  // FIRST child of every module panel — before the identity editor — from
  // the `setups` prop alone, so a fifth module gets its panel with no
  // per-module branch here.
  it("opens a module panel with its setup checklist, ahead of the identity editor", () => {
    const html = renderToStaticMarkup(
      <AdminControls
        viewerLogin="organizer" eventName="OWASP CTF"
        defaultModuleIds={["secure-development"]}
        secureDevAvailable
        initial={settings}
        modules={twoModules}
        setups={{
          quiz: {
            experience: "Contestants answer questions and are graded on submit.",
            steps: [{ title: "Author at least one question", where: "panel", check: { count: "items", noun: "questions" } }],
            midEvent: { safe: ["Retry knobs."], unsafe: ["Correct answers."] },
            docs: { href: "https://example.test/operations#quiz", label: "Quiz guide" },
          },
        }}
      />,
    );
    const quiz = panelFor(html, "quiz");
    const setupAt = quiz.indexOf("Contestants answer questions and are graded on submit.");
    const identityAt = quiz.indexOf('name="moduleTitle:quiz"');
    expect(setupAt).toBeGreaterThan(-1);
    expect(identityAt).toBeGreaterThan(-1);
    expect(setupAt).toBeLessThan(identityAt);
    // Nothing has reported a count yet on first paint, so the checkable step
    // says so rather than claiming there are no questions.
    expect(quiz).toContain("Checking…");
    // A module the registry gave no setup block renders no setup panel — and
    // nothing else in its panel changes.
    expect(panelFor(html, "secure-development")).not.toContain("Setting up");
  });

  // UX audit F3: the blurb help used to say "Not shown on any page … which
  // today means the quiz". The blurb IS rendered — as the page-header lede on
  // /quiz, /flags and /ai, and as those pages' meta description — so the one
  // sentence the field carried about itself was the one false claim on the
  // panel. The help now names the surfaces the docs name.
  it("tells the truth about where the blurb renders", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const quiz = panelFor(html, "quiz");
    expect(quiz).not.toContain("Not shown on any page");
    expect(quiz).toMatch(/lede under the title/);
    expect(quiz).toMatch(/meta description/);
  });

  it("labels a module tab with its resolved title", () => {
    const html = renderToStaticMarkup(
      <AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={[{ id: "quiz", title: "Round 1" }] as never} />,
    );
    expect(html).toContain("Round 1");
  });

  it("renders every tab panel so only visibility is conditional", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    // Overview + Event + Hints + Admins + Sponsors + Support + Activity + Insights + the two modules.
    expect(html.match(/role="region"/g)?.length).toBe(10);
    // Exactly the nine non-selected panels carry `hidden`.
    expect(html.match(/hidden=""/g)?.length).toBe(9);
  });

  it("names each panel for assistive tech and links the sidebar to it", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    for (const [id, label] of [
      ["event", "Event"],
      ["admins", "Admins"],
      ["support", "Support"],
      ["insights", "Insights"],
      ["secure-development", "Secure Development"],
      ["quiz", "Quiz"],
    ]) {
      expect(html).toContain(`id="panel-${id}" aria-label="${label}"`);
      expect(html).toContain(`href="/admin/${id}"`);
    }
  });

  it("marks exactly one sidebar destination current, and it is Overview", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
    // Which one matters: an organizer opening /admin with no deep link lands
    // on the state-at-a-glance screen, not on whichever module happens to be
    // first — and not on the settings form either.
    expect(html).toContain('href="/admin/overview" aria-current="page"');
    // …and it is the Overview panel that is visible, not a hidden one.
    expect(panelFor(html, "overview")).not.toContain('hidden=""');
  });

  it("replaces the old WAI-ARIA tabs widget entirely — every destination is a real, keyboard-reachable link", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('role="tablist"');
    // No roving tabindex trick — a plain `<a>` needs none to be Tab-reachable.
    expect(html).not.toMatch(/tabindex="-1"/i);
  });
});

describe("AdminControls panel contents", () => {
  // Hints are event policy shared by every module that sells them (Secure
  // Development, Classic, AI — hint-store.ts reads the same four settings for
  // all three), so the knobs live on the Event tab. Parking them on Secure
  // Development's tab made them unreachable on any event without that
  // module (UX audit F1). Secure Development keeps the one knob that IS its
  // own: the re-run cooldown.
  it("puts the hint controls on their own Hints panel and leaves only the re-run cooldown on Secure Development", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const secureDev = panelFor(html, "secure-development");
    const eventPanel = panelFor(html, "event");
    const hintsPanel = panelFor(html, "hints");
    expect(hintsPanel).toContain("Hints enabled");
    expect(hintsPanel).toContain("Hint cost");
    expect(hintsPanel).toContain("Hints: solves required");
    expect(hintsPanel).toContain("Hints: unlock after (min)");
    expect(eventPanel).not.toContain("Hint cost");
    expect(secureDev).toContain("Re-run cooldown (min)");
    expect(secureDev).not.toContain("Hint cost");
    expect(secureDev).not.toContain("Hints enabled");
  });

  it("says on the Hints panel which modules the hint policy reaches", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const hintsPanel = panelFor(html, "hints");
    expect(hintsPanel).toMatch(/Classic CTF and AI Challenges sell their hints/);
    // Secure Development is named as having none, and the wording that sent
    // organizers to a tab with no hint field must not survive (issue #334).
    expect(hintsPanel).toMatch(/Secure Development have no hints/);
    expect(hintsPanel).not.toMatch(/Secure Development, Classic CTF and AI Challenges/);
    expect(hintsPanel).not.toMatch(/Each module.s own tab holds the hint text/);
  });

  // UX audit F6: the unlock-after help used to say "a scoring start below",
  // a leftover from the flat layout. Now that Hints is its own destination
  // (not a section of Event), the field names WHERE to find Scoring opens
  // instead of pointing at a field on the same panel.
  it("points the unlock-after help at the Event tab, not 'below'", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const hintsPanel = panelFor(html, "hints");
    expect(hintsPanel).toContain("on the Event tab");
    expect(hintsPanel).not.toContain("a scoring start below");
  });

  it("keeps freeze and registration in the Event panel", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const eventPanel = panelFor(html, "event");
    expect(eventPanel).toContain("Freeze scoring");
    expect(eventPanel).toContain("Team registration open");
    expect(eventPanel).toContain("Schedule (auto dates)");
    expect(eventPanel).toContain("Danger zone");
  });

  // The schedule section states the EFFECTIVE state — toggle AND window,
  // through the shared outsideWindow — so the organizer never computes it in
  // their head from four datetime fields plus two toggles (issue #200, 3.3).
  it("states whether scoring and registration are live right now", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const eventPanel = panelFor(html, "event");
    // Fixture: not paused, no windows, registration open — both live.
    expect(eventPanel).toContain("Right now:");
    expect(eventPanel).toContain("scoring is live");
    expect(eventPanel).toContain("registration is open");
  });

  it("names WHY scoring is frozen — manual freeze vs a closed window", () => {
    const manuallyFrozen = renderToStaticMarkup(
      <AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={{ ...settings, paused: true }} modules={twoModules} />,
    );
    expect(panelFor(manuallyFrozen, "event")).toContain("scoring is frozen (manual)");

    const windowClosed = renderToStaticMarkup(
      <AdminControls
        viewerLogin="organizer" eventName="OWASP CTF"
        defaultModuleIds={["secure-development"]}
        secureDevAvailable
        // A scoring window that ended long ago — the toggle is on, the
        // window is what froze it, and the readout must say which.
        initial={{ ...settings, scoringEndsAt: "2000-01-01T00:00:00.000Z" }}
        modules={twoModules}
      />,
    );
    expect(panelFor(windowClosed, "event")).toContain("scoring is frozen (outside its window)");
  });

  it("renders the quiz module's settings and question authoring in its own panel", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const quizPanel = panelFor(html, "quiz");
    expect(quizPanel).toContain("Max attempts");
    expect(quizPanel).toContain("Retry after (min)");
    expect(quizPanel).toContain("Add question");
    expect(html).not.toContain("No settings for this module yet.");
  });

  it("drops a module's panel entirely when it is not enabled", () => {
    const html = renderToStaticMarkup(
      <AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules.filter((m) => m.id !== "secure-development")} />,
    );
    // Overview + Event + Hints + Admins + Sponsors + Support + Activity +
    // Insights + quiz. The control-plane destinations survive a module being
    // disabled, because none of them is a module tab.
    expect(html.match(/role="region"/g)?.length).toBe(9);
    // The hint policy stays reachable: quiz has no hints, but classic and ai
    // do, and this event can switch either on at runtime.
    expect(panelFor(html, "hints")).toContain("Hint cost");
    expect(() => panelFor(html, "secure-development")).toThrow();
  });

  it("always shows the demo seed/clear section — no DEMO_MODE gate (issue #419)", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const event = panelFor(html, "event");
    expect(event).toMatch(/seed demo data/i);
    expect(event).toMatch(/clear demo data/i);
  });

  // Same captureTree/findElement approach as the reset-confirmation test
  // above: reaches the real onClick closures to read what they hand
  // setConfirm, since ConfirmModal itself never mounts under
  // renderToStaticMarkup.
  it("gates Seed and Clear demo data behind their own typed confirmation phrases (issue #419)", () => {
    const tree = captureTree(AdminControls, {
      viewerLogin: "organizer",
      eventName: "OWASP CTF",
      defaultModuleIds: ["secure-development"],
      secureDevAvailable: true,
      initial: settings,
      modules: twoModules,
    } as Parameters<typeof AdminControls>[0]);

    const eventTabEl = findElement(tree, (el) => el.type === AdminEventTab);
    expect(eventTabEl).not.toBeNull();
    const eventTabProps = eventTabEl!.props as AdminEventTabProps;

    const setConfirm = vi.fn();
    const doSeed = vi.fn();
    const doClearDemo = vi.fn();
    const eventTabTree = AdminEventTab({ ...eventTabProps, setConfirm, doSeed, doClearDemo });

    const seedButton = findElement(eventTabTree, (el) => {
      const children = el.props?.children;
      return el.type === "button" && typeof children === "string" && children === "Seed demo data";
    });
    expect(seedButton).not.toBeNull();
    (seedButton!.props as { onClick: () => void }).onClick();
    expect(setConfirm).toHaveBeenCalledWith(expect.objectContaining({ requireType: "SEED" }));
    (setConfirm.mock.calls[0]![0] as { onConfirm: () => void }).onConfirm();
    expect(doSeed).toHaveBeenCalled();

    setConfirm.mockClear();
    const clearButton = findElement(eventTabTree, (el) => {
      const children = el.props?.children;
      return el.type === "button" && typeof children === "string" && children === "Clear demo data";
    });
    expect(clearButton).not.toBeNull();
    (clearButton!.props as { onClick: () => void }).onClick();
    expect(setConfirm).toHaveBeenCalledWith(expect.objectContaining({ requireType: "CLEAR DEMO DATA" }));
    (setConfirm.mock.calls[0]![0] as { onConfirm: () => void }).onConfirm();
    expect(doClearDemo).toHaveBeenCalled();
  });
});

// Presence is not discoverability: admin-target-list.test.tsx pins
// `nextTargets` and AdminTargetList's own markup directly, but nothing short
// of rendering the REAL panel proves the list is actually mounted on Secure
// Development's tab rather than merely wired to compile.
describe("AdminControls secure-development targets", () => {
  it("mounts all six target checkboxes in the Secure Development panel", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const secureDev = panelFor(html, "secure-development");
    const matches = [...secureDev.matchAll(/<input[^>]*name="secureDevTargets"[^>]*>/g)];
    expect(matches).toHaveLength(6);
  });
});

describe("AdminControls settings audit line", () => {
  const changed = { ...settings, updatedBy: "alice", updatedAt: "2026-08-24T18:00:00.000Z" };
  const render = (initialTab: string) =>
    renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={changed} modules={twoModules} initialTab={initialTab} />);

  it("shows who last changed the settings under the screens that change them", () => {
    expect(render("overview")).toContain("last changed by alice");
    expect(render("event")).toContain("last changed by alice");
    expect(render("hints")).toContain("last changed by alice");
  });

  it("drops it under Activity and Insights, which change nothing", () => {
    // A settings audit line under a table of solves reads as a claim about
    // the table (admin-redesign.md § Activity, Insights).
    expect(render("activity")).not.toContain("last changed by");
    expect(render("insights")).not.toContain("last changed by");
  });
});

describe("AdminControls module identity fields", () => {
  it("renders a title and blurb field in each module panel", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    expect(panelFor(html, "quiz")).toContain('name="moduleTitle:quiz"');
    expect(panelFor(html, "quiz")).toContain('name="moduleBlurb:quiz"');
    expect(panelFor(html, "secure-development")).toContain('name="moduleTitle:secure-development"');
    expect(panelFor(html, "secure-development")).toContain('name="moduleBlurb:secure-development"');
    // Not in the Event panel — module identity is per-module, not global.
    expect(panelFor(html, "event")).not.toContain("moduleTitle:");
  });

  it("shows the stored override as the field value", () => {
    const s = { ...settings, moduleOverrides: { quiz: { title: "Round 1" } } };
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={s} modules={twoModules} />);
    expect(panelFor(html, "quiz")).toContain('value="Round 1"');
  });

  it("leaves the field blank (not the registry default) when there is no override", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    expect(panelFor(html, "quiz")).toContain('name="moduleTitle:quiz" value=""');
  });

  it("shows the registry default as the placeholder, so blank-restores-default is discoverable", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const quizPanel = panelFor(html, "quiz");
    expect(quizPanel).toContain('placeholder="Quiz"');
    expect(quizPanel).toContain('placeholder="Answer security questions for points."');
    expect(quizPanel).toMatch(/blank/i);
  });

  it("caps the fields at the stored maxima", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const quizPanel = panelFor(html, "quiz");
    expect(quizPanel).toContain('maxLength="60"');
    expect(quizPanel).toContain('maxLength="200"');
  });

  it("renders module identity inside the settings card, above the module's knobs and its list", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const quizPanel = panelFor(html, "quiz");
    const cardAt = quizPanel.indexOf(">Settings<");
    const identityAt = quizPanel.indexOf('name="moduleTitle:quiz"');
    const knobAt = quizPanel.indexOf("Max attempts");
    const questionsAt = quizPanel.indexOf("Add question");
    expect(cardAt).toBeGreaterThan(-1);
    expect(identityAt).toBeGreaterThan(cardAt);
    expect(knobAt).toBeGreaterThan(identityAt);
    expect(questionsAt).toBeGreaterThan(knobAt);
  });

  it("links to the Hints screen from the settings card of every module that sells hints, and not from the quiz", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    expect(panelFor(html, "secure-development")).toContain("Hint pricing is on the Hints screen");
    expect(panelFor(html, "quiz")).not.toContain("Hint pricing is on the Hints screen");
  });
});

// Issue #386: nothing else in this file proves the Event tab's Identity
// section is actually mounted — admin-event-identity.test.tsx pins
// EVENT_IDENTITY_ROWS and probes IdentityField directly, neither of which
// touches admin-event-tab.tsx's own JSX, so deleting the whole `<section>`
// there would leave every other suite green (finding from Task 5 review
// round 1). These two assert on the real rendered panel instead.
describe("AdminControls event identity section", () => {
  it("renders one input per identity field, ahead of the module switches", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={twoModules} />);
    const eventPanel = panelFor(html, "event");
    for (const name of ["eventName", "eventTheme", "eventLocation", "eventContact", "eventDiscord"]) {
      expect(eventPanel).toContain(`name="${name}"`);
    }
    const identityAt = eventPanel.indexOf(">Identity<");
    const modulesAt = eventPanel.indexOf(">Modules<");
    expect(identityAt).toBeGreaterThan(-1);
    expect(modulesAt).toBeGreaterThan(-1);
    expect(identityAt).toBeLessThan(modulesAt);
  });

  it("shows the stored override as the field's value", () => {
    const s = { ...settings, eventIdentity: { eventName: "Pinned CTF" } };
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={s} modules={twoModules} />);
    expect(panelFor(html, "event")).toContain('value="Pinned CTF"');
  });
});

// Issue #386, Task 5 review round 1, Important 2: nothing pinned that
// AdminControls' own `eventName` prop (threaded down from admin-panel.tsx's
// getSite() — see page.test.tsx/tab-page.test.tsx for the header half of
// this chain) is what the Event tab's master-reset modal asks the organizer
// to type. `renderToStaticMarkup` never mounts that modal — it is gated
// behind `useState` (see this file's header comment) — so there is no
// rendered string to assert against; a revert to a hardcoded default name
// would leave every markup-only assertion in this file exactly as green as
// it is today. This calls AdminControls, then AdminEventTab, directly
// (bypassing JSX/reconciliation via `captureTree`/`findElement` above) to
// reach the real `onClick` closure and read the object it hands `setConfirm`.
describe("AdminControls reset confirmation — eventName plumbing", () => {
  it("threads AdminControls' eventName prop into the Event tab's reset confirmation phrase", () => {
    const tree = captureTree(AdminControls, {
      viewerLogin: "organizer",
      eventName: "Plumbed CTF",
      defaultModuleIds: ["secure-development"],
      secureDevAvailable: true,
      initial: settings,
      modules: twoModules,
    } as Parameters<typeof AdminControls>[0]);

    const eventTabEl = findElement(tree, (el) => el.type === AdminEventTab);
    expect(eventTabEl).not.toBeNull();
    const eventTabProps = eventTabEl!.props as AdminEventTabProps;
    // Proves admin-controls.tsx actually FORWARDS the prop it was given —
    // not merely that AdminEventTab would honour it if it arrived.
    expect(eventTabProps.eventName).toBe("Plumbed CTF");

    const setConfirm = vi.fn();
    const doReset = vi.fn();
    const eventTabTree = AdminEventTab({ ...eventTabProps, setConfirm, doReset });
    const resetButton = findElement(eventTabTree, (el) => {
      const children = el.props?.children;
      return el.type === "button" && typeof children === "string" && children.includes("Reset event data");
    });
    expect(resetButton).not.toBeNull();
    (resetButton!.props as { onClick: () => void }).onClick();

    // The confirmation copy an organizer would see: ConfirmModal renders
    // "Type <requireType> to confirm" and disables Confirm until the typed
    // text matches it exactly — this IS that surface.
    expect(setConfirm).toHaveBeenCalledWith(expect.objectContaining({ requireType: "Plumbed CTF" }));
    const confirmArg = setConfirm.mock.calls[0][0] as { onConfirm: () => void };
    confirmArg.onConfirm();
    expect(doReset).toHaveBeenCalledWith("Plumbed CTF");
  });
});

// CodeRabbit round 1, #389 (id 3985696440): the reset confirmation phrase
// above is only correct AT MOUNT. A rename saved through the Identity
// section must update it too, or an organizer who just renamed the event can
// type the (correct, freshly-shown) new name into the reset modal and still
// get "confirmation does not match the event name" back from the server,
// which checks against `getSite()` — the STORED name, not the stale prop
// admin-panel.tsx resolved before the rename.
//
// `nextEventNameAfterSave` is the pure decision `applyField` defers to, so
// it's pinned directly here (repo has no jsdom/testing-library, so a live
// re-render can't be observed — see this file's header comment); the
// captureTree case below then proves `AdminControls` actually wires it up:
// the real `applyField` closure, given a stubbed successful `eventName`
// save, posts exactly the patch it was asked to and does not throw doing so.
describe("nextEventNameAfterSave", () => {
  it("leaves the name alone for any other field's save", () => {
    expect(nextEventNameAfterSave("hintCost", "Old CTF", { eventIdentity: { eventName: "Ignored CTF" } })).toBe(
      "Old CTF",
    );
  });

  it("takes the STORED name from the response when the save was an eventName save", () => {
    expect(nextEventNameAfterSave("eventName", "Old CTF", { eventIdentity: { eventName: "New CTF" } })).toBe(
      "New CTF",
    );
  });

  it("falls back to the spec default when the save cleared the override", () => {
    expect(nextEventNameAfterSave("eventName", "Old CTF", { eventIdentity: {} })).toBe(
      DEFAULT_EVENT_IDENTITY.eventName,
    );
  });
});

describe("AdminControls reset confirmation — post-rename save", () => {
  it("posts the renamed value through the real applyField closure the Event tab was given", async () => {
    const tree = captureTree(AdminControls, {
      viewerLogin: "organizer",
      eventName: "Old CTF",
      defaultModuleIds: ["secure-development"],
      secureDevAvailable: true,
      initial: settings,
      modules: twoModules,
    } as Parameters<typeof AdminControls>[0]);

    const eventTabEl = findElement(tree, (el) => el.type === AdminEventTab);
    expect(eventTabEl).not.toBeNull();
    const { applyField } = eventTabEl!.props as AdminEventTabProps;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ settings: { ...settings, eventIdentity: { eventName: "New CTF" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await applyField("eventName", { eventName: "New CTF" }, "Event name");

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/settings");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ eventName: "New CTF" });

    vi.unstubAllGlobals();
  });
});

// Every numeric admin input must SHOW the default it falls back to.
//
// The stored value is the organizer's OVERRIDE, which is null until they touch
// it — so `value={…}` alone renders an empty box. Beside help text reading
// "0 = unlimited" and "0 = no cooldown", an empty box states the opposite of
// the truth: the real defaults are 3 attempts, 5 minutes and 5 seconds.
//
// hint-defaults.ts already exists for exactly this bug on the hints TOGGLE
// (#89): "the admin toggle has to render the same default the server resolves,
// or it misreports the effective state". The number inputs were never brought
// along. This pins that they were.
describe("numeric inputs advertise their default", () => {
  const allModules = [
    { id: "secure-development", title: "Secure Development", blurb: "" },
    { id: "quiz", title: "Quiz", blurb: "" },
    { id: "classic", title: "Classic CTF", blurb: "" },
  ] as unknown as ResolvedModule[];

  it("renders a placeholder equal to the server-side fallback", () => {
    // `settings` here has no overrides, which is the state every fresh event
    // starts in — and the state in which these boxes rendered blank.
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={allModules} />);
    for (const def of [
      HINT_COST,
      HINT_MIN_SOLVES,
      HINT_UNLOCK_AFTER_MIN,
      QUIZ_MAX_ATTEMPTS,
      QUIZ_RETRY_AFTER_MIN,
      CLASSIC_COOLDOWN_SEC,
    ]) {
      expect(html).toContain(`placeholder="${def}"`);
    }
  });

  it("still shows the override, not the default, once one is set", () => {
    const overridden = { ...settings, hintCost: 42 } as AdminSettings;
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={overridden} modules={allModules} />);
    expect(html).toContain('value="42"');
  });
});

// Runtime module enablement (issue #175) — the panel half. Secure Development
// is a normal switch now (issue #386): it locks only without a scorer image,
// and — like every other module — the last live one can still be switched
// off; an empty event is legal (module-toggle.test.ts covers the pure rule).
describe("module toggles", () => {
  const render = (overrides: Partial<typeof settings> = {}, secureDevAvailable = true) =>
    renderToStaticMarkup(
      <AdminControls
        viewerLogin="organizer" eventName="OWASP CTF"
        initial={{ ...settings, ...overrides }}
        modules={twoModules}
        defaultModuleIds={["secure-development"]}
        secureDevAvailable={secureDevAvailable}
      />,
    );

  it("offers a row for every registry module, including one this event has OFF", () => {
    // The whole point of the control is turning a module ON, so a module that
    // is currently off still needs a visible switch. Keying the list off the
    // enabled set would show only what is already running.
    const html = render({ enabledModuleIds: ["secure-development"] });
    expect(html).toContain("Classic CTF");
    expect(html).toContain("Quiz");
  });

  it("shows secure-development as toggleable, with no reason, when a scorer image exists", () => {
    const html = panelFor(render({}, true), "event");
    const input = html.match(/<input id="module-secure-development"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).not.toContain("disabled");
    expect(html).not.toMatch(/no scorer image/);
  });

  // Final-review finding #1, part 3 (issue #386); help text updated for
  // CodeRabbit round 1 finding B: a deployment can have secure-development
  // STORED as on while SCORE_IMAGE is unset (carried forward from when it
  // had one — admin-store's rule). Locking that switch would leave the
  // organizer no way to turn it back off, so it stays switchable off
  // directly AND the server now strips it on the next write to any module.
  it("does not lock secure-development when it is already ON, even with no scorer image — it can be switched off", () => {
    const html = panelFor(render({ enabledModuleIds: ["secure-development"] }, false), "event");
    const input = html.match(/<input id="module-secure-development"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).not.toContain("disabled");
    expect(html).toMatch(/no scorer image/);
    expect(html).toMatch(/switched off on your next change to any module/i);
  });

  it("locks secure-development, with the reason, when it is OFF and there is no scorer image", () => {
    const html = panelFor(render({ enabledModuleIds: ["quiz"] }, false), "event");
    const input = html.match(/<input id="module-secure-development"[^>]*>/)?.[0];
    expect(input).toContain("disabled");
    expect(html).toMatch(/no scorer image/);
  });

  it("says a disabled module's data survives, because that is the question an organizer has", () => {
    expect(render()).toMatch(/deletes nothing|Nothing is deleted/i);
  });
});

// A SEPARATE fixture (not a mutation of `twoModules`/`settings` above) so the
// "7 tabs"/"7 panels" assertions in the first describe block stay pinned to
// exactly the module set they were written against — adding a third module
// to that shared fixture would silently need every one of those counts
// bumped to 8, and a forgotten one would pass for the wrong reason.
describe("AdminControls ai panel", () => {
  const withAi: readonly ResolvedModule[] = [
    ...twoModules,
    { id: "ai", title: "AI Challenges", blurb: "Prompt-injection and jailbreak challenges hosted externally." },
  ];

  it("renders the ai module's tab with an eleventh destination and panel", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={withAi} />);
    expect(html).toContain("AI Challenges");
    expect(html.match(/href="\/admin\//g)?.length).toBe(11);
    expect(html.match(/role="region"/g)?.length).toBe(11);
  });

  it("renders AdminAiControls in the ai panel, not the fallback placeholder", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={withAi} />);
    const aiPanel = panelFor(html, "ai");
    expect(aiPanel).toContain("Submission cooldown (sec)");
    expect(aiPanel).toContain("Add challenge");
    expect(aiPanel).not.toContain("No settings for this module yet.");
  });

  it("keeps the ai cooldown field out of every other panel", () => {
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={withAi} />);
    expect(panelFor(html, "event")).not.toContain("Submission cooldown (sec)");
    expect(panelFor(html, "quiz")).not.toContain("Submission cooldown (sec)");
  });

  it("shows the ai cooldown override, falling back to the module default when unset", () => {
    const withDefault = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={settings} modules={withAi} />);
    expect(panelFor(withDefault, "ai")).toContain(`placeholder="${AI_COOLDOWN_SEC}"`);

    const overridden = { ...settings, aiCooldownSec: 42 };
    const html = renderToStaticMarkup(<AdminControls viewerLogin="organizer" eventName="OWASP CTF" defaultModuleIds={["secure-development"]} secureDevAvailable initial={overridden} modules={withAi} />);
    expect(panelFor(html, "ai")).toContain('value="42"');
  });
});
