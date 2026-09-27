// The story editor's state transitions (#463), pure so they are testable
// without a DOM: every one returns a new list and never mutates its input.

import { describe, expect, it } from "vitest";
import {
  addStep,
  addStory,
  freeChallengeIds,
  moveStep,
  pruneSteps,
  removeStep,
  removeStory,
  renameStory,
  setIntro,
  storyIdFor,
} from "@/components/admin-classic-stories-model";
import type { Story } from "@/lib/story-lock";

const s = (id: string, steps: string[] = [], title = id): Story => ({ id, title, intro: "", steps });

describe("storyIdFor", () => {
  it("slugs the title into the store's id grammar", () => {
    expect(storyIdFor("Operation: Red Dawn!", [])).toBe("operation-red-dawn");
  });
  it("suffixes a taken id until it is unique", () => {
    expect(storyIdFor("Op", [s("op"), s("op-2")])).toBe("op-3");
  });
  it("falls back to a stable stem for a title with no slug characters", () => {
    expect(storyIdFor("¡¿?!", [])).toBe("story");
  });
  it("caps the slug at 64 characters, suffix included", () => {
    const long = "a".repeat(80);
    expect(storyIdFor(long, []).length).toBe(64);
    expect(storyIdFor(long, [s("a".repeat(64))])).toMatch(/^a{62}-2$/);
  });
});

describe("list transitions", () => {
  it("addStory appends an empty story with a trimmed title", () => {
    const next = addStory([s("op")], "  Side quest ");
    expect(next).toEqual([s("op"), { id: "side-quest", title: "Side quest", intro: "", steps: [] }]);
  });
  it("addStory ignores a blank title", () => {
    const list = [s("op")];
    expect(addStory(list, "   ")).toBe(list);
  });
  it("renameStory and setIntro touch only the named story, never its id", () => {
    const list = [s("op"), s("side")];
    expect(renameStory(list, "op", "New")[0]).toEqual({ id: "op", title: "New", intro: "", steps: [] });
    expect(setIntro(list, "side", "Once upon")[1].intro).toBe("Once upon");
    expect(list[0].title).toBe("op");
  });
  it("addStep appends only a challenge that is in no story", () => {
    const list = [s("op", ["a"]), s("side", ["b"])];
    expect(addStep(list, "op", "c")[0].steps).toEqual(["a", "c"]);
    expect(addStep(list, "op", "b")).toBe(list);
    expect(addStep(list, "op", "a")).toBe(list);
  });
  it("moveStep swaps with the neighbour and is a no-op past either end", () => {
    const list = [s("op", ["a", "b", "c"])];
    expect(moveStep(list, "op", 1, -1)[0].steps).toEqual(["b", "a", "c"]);
    expect(moveStep(list, "op", 1, 1)[0].steps).toEqual(["a", "c", "b"]);
    expect(moveStep(list, "op", 0, -1)).toBe(list);
    expect(moveStep(list, "op", 2, 1)).toBe(list);
  });
  it("removeStep and removeStory drop exactly one entry", () => {
    const list = [s("op", ["a", "b"]), s("side")];
    expect(removeStep(list, "op", 0)[0].steps).toEqual(["b"]);
    expect(removeStory(list, "op")).toEqual([s("side")]);
  });
  it("never mutates its input", () => {
    const list = [s("op", ["a", "b"])];
    const snapshot = JSON.stringify(list);
    moveStep(list, "op", 0, 1);
    removeStep(list, "op", 0);
    addStep(list, "op", "c");
    renameStory(list, "op", "x");
    expect(JSON.stringify(list)).toBe(snapshot);
  });
});

describe("pruneSteps / freeChallengeIds", () => {
  it("drops a step whose challenge no longer exists (the store already did)", () => {
    expect(pruneSteps([s("op", ["a", "gone", "b"])], new Set(["a", "b"]))[0].steps).toEqual(["a", "b"]);
  });
  it("lists the challenges no story holds, in the order given", () => {
    expect(freeChallengeIds([s("op", ["b"])], ["a", "b", "c"])).toEqual(["a", "c"]);
  });
});
