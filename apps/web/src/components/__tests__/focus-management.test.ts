// Focus must follow a control that gets replaced.
//
// Three places in this app swap the element the user just activated for a
// different one: the confirm dialog (mounts over the trigger), the challenge
// page's hint button (revealed text replaces the button), and the in-row hint
// chip (the confirm/cancel pair replaces the chip). In every case the HTML
// focus fixup
// rule applies — the browser does NOT move focus to the replacement, it drops
// focus on <body> — so without an explicit `.focus()` the user is silently
// returned to the top of the document mid-interaction.
//
// These are SOURCE-level assertions, deliberately. The repo renders components
// with `renderToStaticMarkup` and has no DOM environment; `team-card.test.tsx`
// records the standing decision not to add `@testing-library/react` for a
// single test. A ref-driven `.focus()` leaves no trace in static markup, so
// there is nothing to assert about the rendered output — what these guard is
// that the focus handling is not quietly deleted. A behavioural test needs a
// DOM environment and is worth its own change, not a smuggled dependency.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

describe("focus follows a replaced control", () => {
  it("hint-reveal-button focuses the revealed text", () => {
    const src = read("hint-reveal-button.tsx");
    // Programmatic target, not added to the tab order.
    expect(src).toMatch(/tabIndex=\{-1\}/);
    expect(src).toMatch(/revealedRef\.current\?\.focus\(\)/);
  });

  it("hint-button focuses the confirm chip it swaps in", () => {
    const src = read("hint-button.tsx");
    expect(src).toMatch(/confirmRef\.current\?\.focus\(\)/);
    // Keyed to the state that MOUNTS a new button. "pending" re-renders the
    // same one, and re-focusing there would fight a user who tabbed to Cancel.
    expect(src).toMatch(/state === "confirm"\) confirmRef/);
  });

  it("hint-button focuses the retry chip when a reveal fails", () => {
    // The confirm/cancel pair unmounts and the retry chip mounts in its place,
    // which is the same replaced-while-focused case one state later. Easy to
    // miss precisely because the first transition is already handled.
    const src = read("hint-button.tsx");
    expect(src).toMatch(/state === "error"\) chipRef\.current\?\.focus\(\)/);
  });

  it("challenge-grid focuses the hint text a purchase reveals", () => {
    // The success path leaves hint-button entirely: the parent swaps the
    // button for the revealed text, so the focus move has to live where the
    // swap does. The id is shared between the element and the focus call
    // through one helper so the two cannot drift apart.
    const src = read("challenge-grid.tsx");
    expect(src).toMatch(/function hintTextId\(/);
    expect(src).toMatch(/id=\{hintTextId\(app\.id, c\.id\)\}/);
    expect(src).toMatch(/tabIndex=\{-1\}/);
    expect(src).toMatch(/document\.getElementById\(target\)\?\.focus\(\)/);
    // Keyed off the purchase, not run on every render.
    expect(src).toMatch(/justPurchased\.current = hintTextId\(app, id\)/);
  });

  it("modal-dialog captures the opener before it focuses anything", () => {
    // The trap moved out of confirm-modal.tsx when the sponsor editor needed
    // a dialog too — one shell, so there is one place for this to rot. The
    // assertions are unchanged; only the file they read is.
    const src = read("modal-dialog.tsx");
    // The ordering IS the fix. React applies `autoFocus` during commit, before
    // a passive effect runs, so an autoFocused input would already be
    // document.activeElement by the time the opener is read — and the cleanup
    // would restore focus to an element being unmounted.
    // Comments stripped first: the reason autoFocus is gone is written out at
    // the call site, and matching that prose would pass no matter what the JSX
    // does — the failure this guards against is the attribute coming back.
    const code = src.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/autoFocus/);
    const effect = src.slice(src.indexOf("const opener = document.activeElement"));
    const capture = effect.indexOf("const opener");
    const focusCall = effect.indexOf(".focus()");
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(focusCall).toBeGreaterThan(capture);
    expect(src).toMatch(/return \(\) => opener\?\.focus\?\.\(\)/);
  });

  it("confirm-modal delegates its dialog mechanics to that shell", () => {
    // Pins the delegation itself: a ConfirmModal that grew its own overlay
    // back would pass every assertion above while quietly reintroducing the
    // second copy of the trap this consolidation removed.
    const src = read("confirm-modal.tsx");
    expect(src).toMatch(/from "@\/components\/modal-dialog"/);
    expect(src).toMatch(/<ModalDialog/);
    expect(src).not.toMatch(/aria-modal/);
    expect(src.replace(/\/\/.*$/gm, "")).not.toMatch(/autoFocus/);
  });
});
