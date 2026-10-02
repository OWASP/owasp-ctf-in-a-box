// HintRevealButton (hint-reveal-button.tsx) is the single challenge page's paid-hint
// control, shared by classic (flags/[id]) and ai (ai/[id]) — generalized from
// the classic-only `ClassicHint` by replacing its hardcoded `app: "classic"`
// reveal-request field with the caller's `app` prop (Task 2, issue #211).
//
// SOURCE-level assertions, same reasoning as focus-management.test.ts: the
// component is a "use client" control whose click handler fires a `fetch` —
// this repo renders with `renderToStaticMarkup` and has no DOM/testing-library
// environment (team-card.test.tsx's standing decision), so there is no click
// to dispatch and nothing in the static markup that reveals the POST body.
// What IS checkable, and what actually regresses if this component reverts to
// a single hardcoded target, is the source of the request itself.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../hint-reveal-button.tsx", import.meta.url)), "utf8");

describe("HintRevealButton posts the target app in its reveal request", () => {
  it("builds the POST body from the app prop", () => {
    expect(src).toMatch(/body:\s*JSON\.stringify\(\{\s*app,\s*id\s*\}\)/);
  });

  it.each(["classic", "ai"] as const)('never hardcodes app: "%s"', (app) => {
    expect(src).not.toMatch(new RegExp(`app:\\s*"${app}"`));
  });
});

// #550: a paid reveal is irreversible, so it must not fire on the first click.
// The control confirms first (idle → confirm → reveal), mirroring the in-row
// `hint-button.tsx` chip, and then acknowledges the deduction so the contestant
// is not left to discover the −cost silently on the leaderboard later. These
// are SOURCE-level assertions for the same reason as the suite above: no DOM.
describe("HintRevealButton confirms before charging and acknowledges the cost (#550)", () => {
  it("opens a confirm step on the first press rather than revealing immediately", () => {
    // The idle button moves to the confirm state; it must NOT call reveal() directly.
    expect(src).toMatch(/onClick=\{\(\) => setState\("confirm"\)\}/);
  });

  it("only fires the reveal request from the confirm step, never the idle button", () => {
    // reveal() is the handler for the confirm button, reached after the gate
    // above. Asserting it is wired EXACTLY once is the negative half: a second
    // `onClick={reveal}` (e.g. retained on the idle button) would make the
    // first press charge immediately and fail this count.
    expect(src).toMatch(/state === "confirm"/);
    expect((src.match(/onClick=\{reveal\}/g) ?? []).length).toBe(1);
  });

  it("offers a cancel that returns to idle without charging", () => {
    expect(src).toMatch(/setState\("idle"\)/);
  });

  it("acknowledges the points spent only when the reveal actually charged", () => {
    // Uses the server's charged amount, and shows it only when something was
    // deducted — a preview (dryRun) or already-owned reveal charges nothing.
    expect(src).toMatch(/−\{chargedCost\} pts spent/);
    expect(src).toMatch(/chargedCost !== null/);
    expect(src).toMatch(/data\.dryRun/);
    expect(src).toMatch(/data\.alreadyOwned/);
  });

  it("restores focus to the idle button when Cancel or a failed reveal returns to idle", () => {
    // The confirm pair unmounts on the way back to idle; without this the
    // focus fixup rule drops focus on <body>. Guarded so the first mount
    // (initial idle) does not steal focus.
    expect(src).toMatch(/ref=\{idleRef\}/);
    expect(src).toMatch(/idleRef\.current\?\.focus\(\)/);
    expect(src).toMatch(/prevState/);
  });
});
