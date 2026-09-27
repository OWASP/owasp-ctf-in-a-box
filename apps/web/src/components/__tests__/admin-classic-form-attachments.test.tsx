// #186: the challenge form carries the Files section — attached to the saved
// challenge's id in edit mode, and a "save first" note on a new draft.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChallengeForm } from "@/components/admin-classic-form";
import { editorFromChallenge, newChallengeEditor } from "@/components/admin-classic-model";

const noop = () => {};
const render = (editor: Parameters<typeof ChallengeForm>[0]["editor"]) =>
  renderToStaticMarkup(
    <ChallengeForm
      editor={editor}
      categories={["Web"]}
      pending={false}
      error={null}
      flagRevealed={false}
      setFlagRevealed={noop}
      onChange={noop}
      onCancel={noop}
      onSubmit={noop}
    />,
  );

describe("ChallengeForm — Files (#186)", () => {
  it("offers the Files section on a saved challenge", () => {
    const html = render(
      editorFromChallenge({
        challenge: { id: "web-one", title: "One", category: "Web", description: "", points: 10, order: 0 },
        flag: "CTF{x}",
        hint: null,
      }),
    );
    expect(html).toContain(">Files<");
    expect(html).toContain('type="file"');
  });

  it("asks a new draft to be saved first", () => {
    expect(render(newChallengeEditor(0, "Web"))).toMatch(/Save the challenge first/);
  });
});
