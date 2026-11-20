// The add/edit form's outer shell, shared by the quiz and classic admin
// panels: heading, the id block that is shown and never editable, the error
// line and the Cancel/Submit footer. Rendered with `renderToStaticMarkup`
// (this repo has no testing-library), so the scroll-into-view effect never
// runs here — what is provable is the markup, the footer's labels and its
// disabled states.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import EditorFrame, { IdBlock, editorHeading } from "@/components/admin/editor-frame";

const noop = () => {};

function renderFrame(overrides: Partial<Parameters<typeof EditorFrame>[0]> = {}) {
  return renderToStaticMarkup(
    <EditorFrame
      heading="Add challenge"
      focusKey="new"
      pending={false}
      valid={true}
      isNew={true}
      addLabel="Add challenge"
      error={null}
      onCancel={noop}
      onSubmit={noop}
      {...overrides}
    >
      <p>fields</p>
    </EditorFrame>,
  );
}

describe("EditorFrame", () => {
  it("renders the heading, the children and both footer buttons", () => {
    const html = renderFrame();
    expect(html).toContain('<h4 class="text-sm font-semibold text-white">Add challenge</h4>');
    expect(html).toContain("<p>fields</p>");
    expect(html).toMatch(/<button[^>]*>Cancel</);
    expect(html).toMatch(/<button[^>]*>Add challenge</);
  });

  it("labels the submit button Save changes for an existing item", () => {
    expect(renderFrame({ isNew: false, heading: 'Edit "X"' })).toMatch(/<button[^>]*>Save changes</);
  });

  it("disables submit while the draft is invalid, and both buttons while saving", () => {
    expect(renderFrame({ valid: false })).toMatch(/<button[^>]*disabled=""[^>]*>Add challenge</);
    const saving = renderFrame({ pending: true });
    expect(saving).toMatch(/<button[^>]*disabled=""[^>]*>Cancel</);
    expect(saving).toMatch(/<button[^>]*disabled=""[^>]*>Saving…</);
  });

  it("renders the error line only when there is one", () => {
    expect(renderFrame({ error: "Store unavailable — try again shortly." })).toContain(
      '<p class="text-sm text-[#e53e3e]">Store unavailable — try again shortly.</p>',
    );
    expect(renderFrame()).not.toContain('<p class="text-sm text-[#e53e3e]">');
  });
});

describe("editorHeading", () => {
  it("uses the add label for a new item and quotes the phrase for an existing one", () => {
    expect(editorHeading(true, "Add question", "ignored")).toBe("Add question");
    expect(editorHeading(false, "Add question", "Which header?")).toBe('Edit "Which header?"');
  });
});

describe("IdBlock", () => {
  it("shows a fixed id as code with its help, never as an input", () => {
    const html = renderToStaticMarkup(
      <IdBlock label="Challenge id" id="sql-injection-101-ab12cd" fixedHelp="Fixed for the life of the challenge." generatedHelp="Generated from the title when you save." />,
    );
    expect(html).toContain("Challenge id");
    expect(html).toMatch(/<code[^>]*>sql-injection-101-ab12cd<\/code>/);
    expect(html).toContain("Fixed for the life of the challenge.");
    expect(html).not.toContain("Generated from the title");
    expect(html).not.toContain("<input");
  });

  it("states that a new item's id is generated", () => {
    const html = renderToStaticMarkup(
      <IdBlock label="Question id" id={undefined} fixedHelp="Fixed." generatedHelp="Generated from the prompt when you save." />,
    );
    expect(html).toContain("Generated from the prompt when you save.");
    expect(html).not.toContain("<code");
    expect(html).not.toContain("<input");
  });
});
