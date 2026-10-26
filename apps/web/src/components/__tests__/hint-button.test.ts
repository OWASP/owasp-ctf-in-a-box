// HintButton (hint-button.tsx), the in-row paid-hint chip on the
// secure-development board. SOURCE-level, for the reason
// hint-reveal-button.test.ts gives:
// a "use client" control with no DOM environment in this suite.
//
// #557: the price on the confirm chip is the price charged, or nothing is.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const renderState = vi.hoisted(() => ({ value: "idle" as "idle" | "confirm" | "pending" | "error" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const [value, setValue] = actual.useState(initial);
      return [initial === "idle" ? renderState.value : value, setValue];
    },
  };
});

import HintButton from "../hint-button";

const src = readFileSync(fileURLToPath(new URL("../hint-button.tsx", import.meta.url)), "utf8");

describe("HintButton charges only the price it showed (#557)", () => {
  it("sends the price on the chip as the quoted cost", () => {
    expect(src).toMatch(/body:\s*JSON\.stringify\(\{\s*app,\s*id,\s*level:\s*1,\s*quotedCost:\s*price\s*\}\)/);
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

// A source-level assertion can pass while the rendered chip says "− pts".
// Render the chip and its confirmation with the price state pinned so the
// amount the contestant is told they will spend has to be in the markup.
describe("HintButton renders the price it charges", () => {
  const props = { app: "juice-shop" as const, id: "c1", cost: 25, signedIn: true, onPurchased: () => {} };

  beforeEach(() => {
    renderState.value = "idle";
  });

  it("renders the price on the idle chip", () => {
    const html = renderToStaticMarkup(createElement(HintButton, props));
    expect(html).toContain("💡 −25");
    expect(html).toContain('title="Reveal hint for 25 points"');
  });

  it("renders the price in the visible and screen-reader confirmation", () => {
    renderState.value = "confirm";
    const html = renderToStaticMarkup(createElement(HintButton, props));
    expect(html).toContain("−25 pts ✓");
    expect(html).toContain("Confirm: spend 25 points on this hint.");
    expect(html).toContain("Confirm, spend 25 points");
    expect(html).not.toContain("spend  points");
  });
});
