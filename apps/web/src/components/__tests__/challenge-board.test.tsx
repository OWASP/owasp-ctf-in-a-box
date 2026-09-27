// The shared board as a category-grouped tile grid (issue #208): tiles are
// links to `basePath`/<id> — /flags/[id] here, /ai/[id] for the ai module —
// carrying only title + points + solved state; the description and the flag
// form live on the challenge's own page now. Static renders are enough: the
// board is a Server Component with no interactivity.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import ChallengeBoard, { type ClassicChallengeView } from "@/components/challenge-board";

const web: ClassicChallengeView = {
  id: "web-sqli-101",
  title: "SQLi 101",
  category: "Web",
  description: "Find the flag hidden behind a login form.",
  points: 50,
  solveCount: 3,
  status: "unsolved",
};

const crypto: ClassicChallengeView = {
  id: "crypto-rsa-basics",
  title: "RSA Basics",
  category: "Crypto",
  description: "Break a small RSA modulus.",
  points: 75,
  solveCount: 1,
  status: "unsolved",
};

describe("ChallengeBoard (tile grid)", () => {
  it("groups tiles under their category headings in the given order", () => {
    const html = renderToStaticMarkup(
      <ChallengeBoard categories={["Web", "Crypto"]} challenges={[web, crypto]} authenticated basePath="/flags" />,
    );
    expect(html.indexOf("Web")).toBeLessThan(html.indexOf("Crypto"));
  });

  it("hides a category with no matching challenges", () => {
    const html = renderToStaticMarkup(
      <ChallengeBoard categories={["Web", "Pwn"]} challenges={[web]} authenticated basePath="/flags" />,
    );
    expect(html).toContain("Web");
    expect(html).not.toContain("Pwn");
  });

  // The tile IS the navigation: title + points, linking to the challenge's
  // own page. No description, no form — those moved to /flags/[id].
  it("renders each challenge as a linked tile with title and points, and nothing more", () => {
    const html = renderToStaticMarkup(
      <ChallengeBoard categories={["Web"]} challenges={[web]} authenticated basePath="/flags" />,
    );
    expect(html).toContain('href="/flags/web-sqli-101"');
    expect(html).toContain("SQLi 101");
    expect(html).toContain("50 pts");
    expect(html).not.toContain("Find the flag hidden behind a login form.");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Submit flag");
  });

  // Availability is public (#190) — the tile says a hint EXISTS, the page
  // sells it. Ids only, never text: hintIds is the public shape.
  it("marks tiles whose challenge has a paid hint on offer", () => {
    const html = renderToStaticMarkup(
      <ChallengeBoard categories={["Web"]} challenges={[web]} authenticated hintIds={["web-sqli-101"]} basePath="/flags" />,
    );
    expect(html).toContain("💡");
    // The tile's aria-label OVERRIDES descendant text, so the emoji alone is
    // invisible to a screen reader — the label must say it (CodeRabbit #210).
    expect(html).toContain("50 points, paid hint available");
    const without = renderToStaticMarkup(
      <ChallengeBoard categories={["Web"]} challenges={[web]} authenticated basePath="/flags" />,
    );
    expect(without).not.toContain("💡");
    expect(without).not.toContain("paid hint available");
  });

  it("URL-encodes a challenge id in the tile link", () => {
    const odd = { ...web, id: "web/one two" };
    const html = renderToStaticMarkup(
      <ChallengeBoard categories={["Web"]} challenges={[odd]} authenticated basePath="/flags" />,
    );
    expect(html).toContain('href="/flags/web%2Fone%20two"');
  });

  // A solved tile must LOOK solved and be announced — not just exist.
  it("marks a solved tile visibly and for screen readers", () => {
    const html = renderToStaticMarkup(
      <ChallengeBoard
        categories={["Web"]}
        challenges={[{ ...web, status: "solved", earnedPoints: 50 }]}
        authenticated
        basePath="/flags"
      />,
    );
    expect(html).toContain("border-[#22c55e]/40");
    expect(html).toContain("(solved)");
  });

  it("summarizes progress once, over the rendered set, for a signed-in viewer", () => {
    const html = renderToStaticMarkup(
      <ChallengeBoard
        categories={["Web", "Crypto"]}
        challenges={[{ ...web, status: "solved", earnedPoints: 50 }, crypto]}
        authenticated
        basePath="/flags"
      />,
    );
    expect(html).toContain("/ 2 solved");
    expect(html).toContain("/ 125 pts");
    // A challenge in an unlisted category must not inflate the totals — the
    // CodeRabbit finding on the old rail, kept fixed on the grid.
    const withStray = renderToStaticMarkup(
      <ChallengeBoard
        categories={["Web"]}
        challenges={[web, { ...crypto, category: "Hidden" }]}
        authenticated
        basePath="/flags"
      />,
    );
    expect(withStray).toContain("/ 1 solved");
    expect(withStray).toContain("/ 50 pts");
  });

  it("shows no personal summary to a signed-out visitor", () => {
    const html = renderToStaticMarkup(
      <ChallengeBoard categories={["Web"]} challenges={[web]} authenticated={false} basePath="/flags" />,
    );
    expect(html).not.toContain("/ 1 solved");
    // Tiles stay browsable.
    expect(html).toContain("SQLi 101");
  });

  // Simulates an accidental leak — e.g. someone spreading a raw store record
  // (which DOES carry a flag) into props instead of building the public view
  // model field by field. The grid must never echo such a field into markup
  // even if it somehow arrived here.
  it("never lets a flag reach the markup, even if props carried a leaked field", () => {
    const leaked = { ...web, flag: "CTF{leaked}", flagnorm: "ctf{leaked}" } as unknown as ClassicChallengeView;
    const html = renderToStaticMarkup(<ChallengeBoard categories={["Web"]} challenges={[leaked]} authenticated basePath="/flags" />);
    expect(html).not.toContain("CTF{leaked}");
    expect(html).not.toContain("ctf{leaked}");
  });
});

describe("the run rail counts open story steps too (#463, review M3)", () => {
  it("includes runExtras (open story steps, rendered in their lane) in the rail's totals", () => {
    const solvedStep: ClassicChallengeView = { ...web, id: "story-step", title: "Step 1", status: "solved", earnedPoints: 50 };
    const without = renderToStaticMarkup(<ChallengeBoard categories={["Web"]} challenges={[web]} authenticated basePath="/flags" />);
    const withStep = renderToStaticMarkup(
      <ChallengeBoard categories={["Web"]} challenges={[web]} runExtras={[solvedStep]} authenticated basePath="/flags" />,
    );
    expect(without).toContain("/ 1 solved");
    expect(withStep).toContain("/ 2 solved");
    // The extra is counted, not rendered as a tile here — it lives in its lane.
    expect(withStep).not.toContain('href="/flags/story-step"');
  });
});
