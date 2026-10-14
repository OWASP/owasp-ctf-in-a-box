// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. AdminNumberField is presentational — the draft
// value and the save status arrive as props from the shell — so
// `renderToStaticMarkup` can show it in every state an organizer can see it
// in. The commit decision the shell makes on blur is a pure function here
// (`parseNumberCommit`), so it is provable without a DOM event, the same way
// the module panels prove their form logic.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AdminNumberField, { blurOnWheel, describeFieldError, parseNumberCommit } from "@/components/admin-number-field";

const noop = () => {};
const base = {
  id: "hint-cost",
  label: "Hint cost",
  help: "Points deducted from the buyer when a hint is revealed.",
  value: "",
  placeholder: "10",
  min: 0,
  disabled: false,
  onChange: noop,
  onBlur: noop,
};

describe("AdminNumberField", () => {
  it("renders the label, help, placeholder and current value", () => {
    const html = renderToStaticMarkup(<AdminNumberField {...base} value="42" status={{ state: "idle" }} />);
    expect(html).toContain("Hint cost");
    expect(html).toContain("Points deducted from the buyer");
    expect(html).toContain('placeholder="10"');
    expect(html).toContain('value="42"');
    expect(html).toContain('type="number"');
  });

  it("says nothing while idle", () => {
    const html = renderToStaticMarkup(<AdminNumberField {...base} status={{ state: "idle" }} />);
    expect(html).not.toContain("Saving");
    expect(html).not.toContain("Saved");
    expect(html).not.toContain('role="alert"');
  });

  it("says Saving while the write is in flight and Saved once it lands", () => {
    expect(renderToStaticMarkup(<AdminNumberField {...base} status={{ state: "pending" }} />)).toContain("Saving…");
    expect(renderToStaticMarkup(<AdminNumberField {...base} status={{ state: "saved" }} />)).toContain("Saved");
  });

  it("announces a rejection beside the field and ties it to the input", () => {
    const html = renderToStaticMarkup(
      <AdminNumberField {...base} status={{ state: "rejected", message: "Hint cost must be a whole number between 0 and 100,000." }} />,
    );
    expect(html).toContain("Hint cost must be a whole number between 0 and 100,000.");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="hint-cost-status"');
    expect(html).toContain('id="hint-cost-status"');
  });

  it("does not mark the input invalid when nothing is wrong", () => {
    const html = renderToStaticMarkup(<AdminNumberField {...base} status={{ state: "saved" }} />);
    expect(html).not.toContain("aria-invalid");
  });

  it("hides the native spinner but stays a number input", () => {
    // The WebKit stepper clipped five-figure values at this width and moved a
    // stored setting on a stray scroll (admin-redesign.md § Controls).
    const html = renderToStaticMarkup(<AdminNumberField {...base} value="10000" status={{ state: "idle" }} />);
    expect(html).toContain('type="number"');
    expect(html).toContain("[appearance:textfield]");
    expect(html).toContain("[&amp;::-webkit-inner-spin-button]:appearance-none");
  });
});

// The CSS hides the stepper buttons only; a focused number input still steps
// on a mouse wheel, and the blur after it would save a value nobody typed.
// The wheel handler drops focus, which is what stops the step. No browser
// harness here (by choice), so the handler is exercised directly.
describe("blurOnWheel", () => {
  it("drops focus from the wheeled input", () => {
    let blurred = 0;
    blurOnWheel({ currentTarget: { blur: () => void blurred++ } });
    expect(blurred).toBe(1);
  });
});

// The server's validation strings are keyed by the stored field
// (`hintCost must be an integer in [0, 100000]`). The organizer read a label,
// not a key, so the field translates before it shows.
describe("describeFieldError", () => {
  it("rewrites the integer-range message through the label", () => {
    expect(describeFieldError("Hint cost", "hintCost must be an integer in [0, 100000]")).toBe(
      "Hint cost must be a whole number between 0 and 100,000.",
    );
  });

  it("rewrites the length message through the label", () => {
    expect(describeFieldError("Title", "moduleTitle:quiz must be at most 60 characters")).toBe(
      "Title must be at most 60 characters.",
    );
  });

  it("keeps an unrecognised message, prefixed by the label, rather than hiding it", () => {
    expect(describeFieldError("Hint cost", "settings write failed")).toBe("Hint cost could not be saved: settings write failed");
  });
});

// What the shell does on blur, as data: snap back with a reason, do nothing,
// or post the parsed value. The old commit snapped back SILENTLY on junk
// (audit F2); the reason is now part of the decision. A blanked field over a
// stored value is a CLEAR: the server removes the override and the default
// applies again (#600).
describe("parseNumberCommit", () => {
  it("is a no-op when the value is unchanged", () => {
    expect(parseNumberCommit("42", 42)).toEqual({ kind: "noop" });
    expect(parseNumberCommit("", null)).toEqual({ kind: "noop" });
  });

  it("posts a changed whole number", () => {
    expect(parseNumberCommit("7", 42)).toEqual({ kind: "post", value: 7 });
    expect(parseNumberCommit("0", null)).toEqual({ kind: "post", value: 0 });
  });

  it("snaps back with a reason on junk, a fraction or a negative", () => {
    expect(parseNumberCommit("abc", 42)).toEqual({ kind: "snapback", message: "Whole numbers only — kept 42." });
    expect(parseNumberCommit("1.5", 42)).toEqual({ kind: "snapback", message: "Whole numbers only — kept 42." });
    expect(parseNumberCommit("-3", null)).toEqual({ kind: "snapback", message: "Whole numbers only — kept the default." });
  });

  it("clears the override when the field is blanked over a stored value", () => {
    expect(parseNumberCommit("", 42)).toEqual({ kind: "post", value: null });
    expect(parseNumberCommit("   ", 0)).toEqual({ kind: "post", value: null });
  });
});
