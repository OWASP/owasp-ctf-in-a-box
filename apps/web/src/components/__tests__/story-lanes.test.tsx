// #595: a visible story step shows how many teams solved it, like a tile. A
// locked step shows none: ADR 60 keeps a locked step invisible, and its count
// would say something about it.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import StoryLanes from "@/components/story-lanes";

const open = { locked: false as const, id: "recon", title: "Recon", category: "Web", points: 10, solved: false, position: 1, total: 2, teamsSolved: 4, firstBlood: null };
const lane = {
  id: "op",
  title: "Operation",
  intro: "",
  steps: [open, { locked: true as const, key: "op:2", label: "??? — step 2 of 2" }],
};

describe("StoryLanes solve counts", () => {
  it("shows the count on a visible step and none on a locked one", () => {
    const html = renderToStaticMarkup(<StoryLanes stories={[lane]} basePath="/flags" />);
    expect(html).toContain("4 teams");
    expect(html.match(/\d+ teams?\b/g)).toEqual(["4 teams"]);
  });

  it("shows no count on a visible step whose count could not be read", () => {
    const html = renderToStaticMarkup(
      <StoryLanes stories={[{ ...lane, steps: [{ ...open, teamsSolved: null }] }]} basePath="/flags" />,
    );
    expect(html).not.toMatch(/\d+ teams?\b/);
  });
});

// #188: an open step names its first solver like a tile does. A locked step's
// view has no field that could carry one.
describe("StoryLanes first blood", () => {
  it("names the first solver on a visible step, and nothing on a locked one", () => {
    const html = renderToStaticMarkup(
      <StoryLanes stories={[{ ...lane, steps: [{ ...open, firstBlood: "alice" }, lane.steps[1]] }]} basePath="/flags" />,
    );
    expect(html).toContain("First blood: alice");
    expect(html).toContain("Recon, 10 points, first blood by alice");
    // Once as text (the title attribute repeats it for a truncated login).
    expect(html.match(/<\/span>First blood:/g)).toHaveLength(1);
  });

  it("shows no first blood on a visible step nobody has solved", () => {
    const html = renderToStaticMarkup(<StoryLanes stories={[{ ...lane, steps: [{ ...open, firstBlood: null }] }]} basePath="/flags" />);
    expect(html).not.toMatch(/first blood/i);
  });
});
