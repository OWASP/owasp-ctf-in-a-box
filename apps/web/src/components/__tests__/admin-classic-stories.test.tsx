// The story editor's static render (#463). Transitions are the model's and
// are tested there; this pins what an organizer sees: each story's title and
// intro fields, its steps by challenge title with ↑ ↓ ✕, the "Add step"
// options (only challenges in no story), and New story / Save.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AdminClassicStories from "@/components/admin-classic-stories";

const challenges = [
  { id: "a-1", title: "Recon" },
  { id: "b-2", title: "Foothold" },
  { id: "c-3", title: "Loot" },
];
const render = (stories: Parameters<typeof AdminClassicStories>[0]["stories"], loading = false) =>
  renderToStaticMarkup(
    <AdminClassicStories challenges={challenges} stories={stories} loading={loading} onSaved={() => {}} />,
  );

describe("AdminClassicStories", () => {
  it("renders each step with its move and remove controls, ends disabled", () => {
    const html = render([{ id: "op", title: "Operation", intro: "Go.", steps: ["a-1", "b-2"] }]);
    expect(html).toContain('value="Operation"');
    expect(html).toContain("Go.");
    expect(html).toMatch(/aria-label="Move &quot;Recon&quot; up"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Move &quot;Foothold&quot; down"[^>]*disabled/);
    expect(html).toContain('aria-label="Remove &quot;Recon&quot; from Operation"');
  });

  it("offers only challenges no story holds as a new step", () => {
    const html = render([{ id: "op", title: "Operation", intro: "", steps: ["a-1"] }]);
    const select = html.slice(html.indexOf("<select"), html.indexOf("</select>"));
    expect(select).toContain("Loot");
    expect(select).toContain("Foothold");
    expect(select).not.toContain("Recon");
  });

  it("drops a step whose challenge no longer exists", () => {
    const html = render([{ id: "op", title: "Operation", intro: "", steps: ["gone-zz", "a-1"] }]);
    expect(html).not.toContain("gone-zz");
    expect(html).toContain("Recon");
  });

  it("says so when there are no stories, and Checking… while loading", () => {
    expect(render([])).toMatch(/No stories yet/);
    expect(render([], true)).toContain("Checking…");
  });
});
