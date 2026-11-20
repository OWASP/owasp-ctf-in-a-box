// The form fields the classic challenge form uses (and the quiz's
// points/position pair): each one rendered statically to pin the label, the
// control type and the attributes an organizer's browser relies on — the
// masked flag, the description's length cap, the preview through the board's
// own Markdown renderer.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MARKDOWN_MAX } from "@/lib/markdown";
import {
  CaseSensitiveField,
  CategorySelect,
  DescriptionField,
  FlagField,
  HintField,
  NumberField,
  PositionReadout,
  TextField,
} from "@/components/admin/editor-fields";

const noop = () => {};

describe("TextField", () => {
  it("renders a labelled plain input with the value", () => {
    const html = renderToStaticMarkup(<TextField label="Title" value="SQL Injection 101" disabled={false} onChange={noop} />);
    expect(html).toContain("Title");
    expect(html).toMatch(/<input[^>]*value="SQL Injection 101"/);
    expect(html).not.toContain('type="password"');
  });

  it("disables the input while saving", () => {
    expect(renderToStaticMarkup(<TextField label="Title" value="" disabled={true} onChange={noop} />)).toMatch(/<input[^>]*disabled=""/);
  });

  it("states type=text, which is how EditorFrame finds it to focus (#282)", () => {
    // An attribute-less input behaves identically but does not match
    // `input[type='text']`, so the classic form opened with the cursor
    // nowhere. Asserted on the attribute rather than on focus because these
    // tests render to static markup and never mount.
    expect(renderToStaticMarkup(<TextField label="Title" value="" disabled={false} onChange={noop} />)).toMatch(
      /<input[^>]*type="text"/,
    );
  });
});

describe("NumberField", () => {
  it("renders a number input with min 0 and the given max", () => {
    const html = renderToStaticMarkup(<NumberField label="Points" value="50" max={1000} disabled={false} onChange={noop} />);
    expect(html).toContain("Points");
    expect(html).toMatch(/<input[^>]*type="number"[^>]*min="0"[^>]*max="1000"[^>]*value="50"/);
  });

  it("omits max when none is given — the quiz caps nothing", () => {
    expect(renderToStaticMarkup(<NumberField label="Points" value="10" disabled={false} onChange={noop} />)).not.toContain("max=");
  });
});

describe("CategorySelect", () => {
  it("lists the categories with the current one selected", () => {
    const html = renderToStaticMarkup(<CategorySelect value="Web" categories={["Web", "Crypto"]} disabled={false} onChange={noop} />);
    expect(html).toContain("Category");
    expect(html).toMatch(/<option value="Web" selected="">Web<\/option>/);
    expect(html).toContain('<option value="Crypto">Crypto</option>');
    expect(html).not.toContain("Select a category");
  });

  it("offers a disabled placeholder when the draft's category is not in the list", () => {
    const html = renderToStaticMarkup(<CategorySelect value="" categories={["Web"]} disabled={false} onChange={noop} />);
    expect(html).toMatch(/<option[^>]*disabled=""[^>]*>Select a category<\/option>/);
    const removed = renderToStaticMarkup(<CategorySelect value="Gone" categories={["Web"]} disabled={false} onChange={noop} />);
    expect(removed).toMatch(/<option[^>]*disabled=""[^>]*>Gone<\/option>/);
  });
});

describe("PositionReadout", () => {
  it("states the position, marking a new item as last, with nothing to type", () => {
    const fresh = renderToStaticMarkup(<PositionReadout order={4} isNew={true} />);
    expect(fresh).toContain("Position");
    expect(fresh).toContain("#4 (last)");
    expect(fresh).not.toContain("<input");
    expect(renderToStaticMarkup(<PositionReadout order={2} isNew={false} />)).toMatch(/>#2<\/span>/);
  });
});

describe("FlagField", () => {
  it("masks the stored flag until revealed", () => {
    const html = renderToStaticMarkup(<FlagField value="CTF{real}" revealed={false} onToggle={noop} disabled={false} onChange={noop} />);
    expect(html).toContain('type="password"');
    expect(html).toMatch(/value="CTF{real}"/);
    expect(html).toMatch(/>Reveal</);
  });

  it("switches to a plain text input once revealed", () => {
    const html = renderToStaticMarkup(<FlagField value="CTF{real}" revealed={true} onToggle={noop} disabled={false} onChange={noop} />);
    expect(html).toContain('type="text"');
    expect(html).not.toContain('type="password"');
    expect(html).toMatch(/>Hide</);
  });
});

describe("CaseSensitiveField", () => {
  it("renders the checkbox with the module's own help sentence", () => {
    const html = renderToStaticMarkup(<CaseSensitiveField checked={true} disabled={false} onChange={noop} help="Only when the case IS the answer." />);
    expect(html).toContain("Case-sensitive flag");
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(html).toContain("Only when the case IS the answer.");
  });
});

describe("HintField", () => {
  it("renders the hint textarea with the paid-hint explanation", () => {
    const html = renderToStaticMarkup(<HintField value="Look at the headers." disabled={false} onChange={noop} />);
    expect(html).toContain("Hint (optional)");
    expect(html).toMatch(/<textarea[^>]*>Look at the headers.<\/textarea>/);
  });
});

describe("DescriptionField", () => {
  it("caps the textarea at MARKDOWN_MAX and says so", () => {
    const html = renderToStaticMarkup(<DescriptionField value="" disabled={false} onChange={noop} />);
    expect(html).toContain(`Description (Markdown, max ${MARKDOWN_MAX} characters)`);
    expect(html).toMatch(new RegExp(`<textarea[^>]*maxLength="${MARKDOWN_MAX}"`));
  });

  it("previews through the same renderer the board uses", () => {
    const html = renderToStaticMarkup(<DescriptionField value="**b**" disabled={false} onChange={noop} />);
    expect(html).toContain("Preview");
    expect(html).toMatch(/<strong[^>]*>b<\/strong>/);
  });
});
