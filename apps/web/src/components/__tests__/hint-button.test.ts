// HintButton (hint-button.tsx), the in-row paid-hint chip on the Jeopardy and
// AI boards. SOURCE-level, for the reason hint-reveal-button.test.ts gives:
// a "use client" control with no DOM environment in this suite.
//
// #557: the price on the confirm chip is the price charged, or nothing is.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../hint-button.tsx", import.meta.url)), "utf8");

describe("HintButton charges only the price it showed (#557)", () => {
  it("sends the price on the chip as the quoted cost", () => {
    expect(src).toMatch(/body:\s*JSON\.stringify\(\{\s*app,\s*id,\s*quotedCost:\s*price\s*\}\)/);
  });

  it("shows the price from state on every label", () => {
    expect(src).toMatch(/useState\(cost\)/);
    expect(src).not.toMatch(/\$\{cost\}/);
  });

  it("on a 409 with a price, takes the new price and returns to the confirm step", () => {
    expect(src).toMatch(/res\.status === 409 && typeof data\.cost === "number"/);
    expect(src).toMatch(/setPrice\(data\.cost\)/);
  });
});
