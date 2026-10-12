// #595: a visible story step shows how many teams solved it, like a tile. A
// locked step shows none: ADR 60 keeps a locked step invisible, and its count
// would say something about it.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import StoryLanes from "@/components/story-lanes";

const open = { locked: false as const, id: "recon", title: "Recon", category: "Web", points: 10, solved: false, position: 1, total: 2, teamsSolved: 4 };
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
