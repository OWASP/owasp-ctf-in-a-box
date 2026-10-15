// The Freeze switch's copy (audit F11).
//
// Two screens flip one setting, so the copy lives in one module and both
// import it. What is worth pinning is not the wording but the claims an
// organizer will repeat to a room, and the one quotation that has a second
// source of truth elsewhere in the app.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FREEZE_HELP, PAUSED_CONTESTANT_MESSAGE, freezeConfirm } from "../freeze-copy";

describe("the sentence the panel quotes to the organizer", () => {
  // The panel tells an organizer what a contestant sees. If a board's message
  // is reworded and this is not, the panel starts quoting a sentence that
  // exists nowhere — worse than quoting none, because a help desk would be
  // hunting for it. Read from source rather than imported: both boards are
  // client components that pull in the whole store layer, and this assertion
  // needs the string, not the module.
  it.each(["src/components/quiz-board.tsx", "src/components/challenge-detail.tsx"])(
    "is the message %s actually renders",
    (path) => {
      expect(readFileSync(path, "utf8")).toContain(PAUSED_CONTESTANT_MESSAGE);
    },
  );
});

describe("FREEZE_HELP", () => {
  it("names the submissions that are refused", () => {
    expect(FREEZE_HELP).toMatch(/quiz/i);
    expect(FREEZE_HELP).toMatch(/classic/i);
    expect(FREEZE_HELP).toMatch(/ai/i);
  });

  it("says fork Actions keep going", () => {
    // `docs/operations.md`: freezing "freezes scoring, not fork Actions" —
    // a contestant's PR is still judged and commented on.
    expect(FREEZE_HELP).toMatch(/fork Actions keep judging/i);
  });

  it("says a PR scored during the freeze never counts, not that it waits", () => {
    // ADR 67: a Secure Development score is judged at its comment's time, so
    // one posted while frozen is refused for good. An organizer who reads
    // "held until you unfreeze" freezes to hold scores and loses them.
    expect(FREEZE_HELP).toMatch(/scored while frozen never counts/i);
    expect(FREEZE_HELP).not.toMatch(/only once you unfreeze|held|deferred/i);
  });
});

describe("freezeConfirm", () => {
  it("quotes what the contestant will read, in the freeze direction", () => {
    const { title, body, confirmLabel } = freezeConfirm(true);
    expect(title).toBe("Freeze scoring?");
    expect(confirmLabel).toBe("Freeze");
    expect(body).toContain(PAUSED_CONTESTANT_MESSAGE);
    // What an organizer relays at a help desk: a PR scored before the freeze
    // still counts, one scored during it never does, and the contestant
    // pushes again after the unfreeze.
    expect(body).toMatch(/scored before you freeze still count/i);
    expect(body).toMatch(/scored while frozen never count/i);
    expect(body).toMatch(/push again/i);
    expect(body).not.toMatch(/Nothing is dropped|what is held/i);
  });

  it("does not promise that scores judged while frozen land, in the unfreeze direction", () => {
    const { title, body, confirmLabel } = freezeConfirm(false);
    expect(title).toBe("Unfreeze scoring?");
    expect(confirmLabel).toBe("Unfreeze");
    expect(body).toMatch(/scored while frozen/i);
    expect(body).toMatch(/push again/i);
    expect(body).not.toMatch(/picked up from where ingestion stopped/i);
  });

  it("gives the two directions different copy — not one sentence with a word flipped", () => {
    expect(freezeConfirm(true).body).not.toBe(freezeConfirm(false).body);
  });
});
