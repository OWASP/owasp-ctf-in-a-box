// The module switch's rules, shared by Event's Modules section and each
// module panel's header switch. Pure, so provable by direct call — the two
// callers can only differ in where they render, never in what they decide.
import { describe, expect, it } from "vitest";
import { moduleChoices, moduleToggleConfirm, moduleToggleState } from "@/app/(site)/admin/module-toggle";

const quiz = { id: "quiz", label: "Quiz", toggleable: true };
const classic = { id: "classic", label: "Jeopardy", toggleable: true };
const secdev = {
  id: "secure-development",
  label: "Secure Development",
  toggleable: false,
  reason: "This deployment has no scorer image.",
};

describe("moduleChoices", () => {
  it("every module is toggleable when a scorer image exists", () => {
    for (const c of moduleChoices(true)) expect(c.toggleable).toBe(true);
  });
  it("only secure-development is locked when there is no scorer image, with the reason", () => {
    const sd = moduleChoices(false).find((c) => c.id === "secure-development")!;
    expect(sd.toggleable).toBe(false);
    expect(sd.reason).toMatch(/no scorer image/);
    for (const c of moduleChoices(false).filter((c) => c.id !== "secure-development")) expect(c.toggleable).toBe(true);
  });
  it("the last live module can be switched off — an empty event is legal", () => {
    const quiz = moduleChoices(true).find((c) => c.id === "quiz")!;
    const state = moduleToggleState(quiz, new Set(["quiz"]));
    expect(state.disabled).toBe(false);
    expect(state.help).toBeUndefined();
  });
});

describe("moduleToggleState", () => {
  it("reads on/off from the live set", () => {
    expect(moduleToggleState(quiz, new Set(["quiz", "classic"]))).toEqual({ on: true, disabled: false, help: undefined });
    expect(moduleToggleState(classic, new Set(["quiz"]))).toMatchObject({ on: false, disabled: false });
  });

  it("locks a non-toggleable module that is OFF, and says why", () => {
    expect(moduleToggleState(secdev, new Set(["quiz"]))).toEqual({
      on: false,
      disabled: true,
      help: "This deployment has no scorer image.",
    });
  });

  // Final-review finding #1, part 3 (issue #386); help text updated for
  // CodeRabbit round 1 finding B: a deployment can have a stored,
  // already-on secure-development while SCORE_IMAGE is unset (see
  // admin-store's carry-forward rule). Locking the switch there would strand
  // the organizer with no way to turn it back off — so a locked-but-live
  // module stays switchable off directly, AND the server now strips it from
  // what gets stored on the next write to any module (ruling B), so the
  // help text says that instead of implying the switch is the only way off.
  it("does NOT lock a non-toggleable module that is already ON — it can be switched off", () => {
    expect(moduleToggleState(secdev, new Set(["secure-development", "quiz"]))).toEqual({
      on: true,
      disabled: false,
      help: "This deployment has no scorer image. It is switched off on your next change to any module.",
    });
  });
});

describe("moduleToggleConfirm", () => {
  it("adds the module to the set on enable, with the enable copy", () => {
    const c = moduleToggleConfirm(classic, true, new Set(["quiz"]));
    expect(c.ids).toEqual(["quiz", "classic"]);
    expect(c.title).toBe("Enable Jeopardy?");
    expect(c.confirmLabel).toBe("Enable");
    expect(c.body).toMatch(/appears in the nav/);
  });

  it("removes it on disable and says nothing is deleted", () => {
    const c = moduleToggleConfirm(quiz, false, new Set(["quiz", "classic"]));
    expect(c.ids).toEqual(["classic"]);
    expect(c.title).toBe("Disable Quiz?");
    expect(c.confirmLabel).toBe("Disable");
    expect(c.body).toMatch(/Nothing is deleted/);
  });
});
