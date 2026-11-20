// The deprecated-module notice renders the registry's note and a real link
// to the replacement guide, wherever a switch help line or confirmation
// body puts it.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { withDeprecation } from "@/app/(site)/admin/module-deprecation";

const deprecated = { note: "Deprecated: gone in v2.0.0.", guide: { href: "https://example.test/guide#jeopardy", label: "Jeopardy organizer guide" } };

describe("withDeprecation", () => {
  it("returns the text untouched when the module is not deprecated", () => {
    expect(withDeprecation("Plain help.", undefined)).toBe("Plain help.");
    expect(withDeprecation(undefined, undefined)).toBeUndefined();
  });

  it("appends the note and an anchor to the guide, opened in a new tab", () => {
    const html = renderToStaticMarkup(<>{withDeprecation("Locked here.", deprecated)}</>);
    expect(html).toContain("Locked here. ");
    expect(html).toContain("Deprecated: gone in v2.0.0.");
    expect(html).toMatch(/<a href="https:\/\/example\.test\/guide#jeopardy" target="_blank" rel="noopener noreferrer"[^>]*>Jeopardy organizer guide<\/a>/);
  });

  it("renders the notice alone when there is no help text", () => {
    const html = renderToStaticMarkup(<>{withDeprecation(undefined, deprecated)}</>);
    expect(html.startsWith("<span>Deprecated: gone in v2.0.0.")).toBe(true);
  });
});
