// @testing-library/react is not a dependency of this repo and must not be
// added just for this test. AdminAiControls has one effect (the mount-time
// GET /api/admin/ai fetch), which never runs under `renderToStaticMarkup` —
// same pattern as admin-classic-controls.test.tsx.
//
// The add/edit form and the delete ConfirmModal are gated behind `useState`
// in `AdminAiControls` itself (`editing`, `deleteTarget`), so neither ever
// appears in a plain static render of that component — clicking "Edit" is a
// browser interaction this repo's test setup cannot simulate. `AiChallengeForm`
// is exported specifically so its masking/mode-gating/preview properties can
// be proven by rendering it DIRECTLY — the same component `AdminAiControls`
// mounts once an organizer clicks Edit, not a copy. `ConfirmModal` is
// likewise rendered directly (with the copy `aiChallengeDeleteConfirm`
// produces) to prove the delete confirmation is gated on the typed phrase —
// its Confirm button starts `disabled` because the modal's own `typed` state
// starts empty and `renderToStaticMarkup` never runs the keystroke that would
// change it. Everything else not reachable this way is proven through the
// exported pure helpers (`isAiDraftValid`, `payloadFromAiEditor`,
// `draftFromAiChallenge`, `categoryUsageCount`, `commitAiCooldown`, ...) —
// this repo's tests run in vitest's `node` environment (no jsdom), so a real
// blur/click event can never be dispatched; `commitAiCooldown` exists so the
// cooldown field's wiring is provable without one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ConfirmModal from "@/components/confirm-modal";
import type { AdminAiChallenge, AiChallenge } from "@/lib/ai-store";
import AdminAiControls, {
  AiChallengeForm,
  aiCategoriesRequestBody,
  aiChallengeDeleteConfirm,
  categoryUsageCount,
  commitAiCooldown,
  describeAiError,
  draftFromAiChallenge,
  editorFromAiChallenge,
  emptyAiDraft,
  isAiDraftValid,
  newAiChallengeEditor,
  payloadFromAiEditor,
  type AiChallengeDraft,
} from "@/components/admin-ai-controls";

const noop = () => {};

const c1: AiChallenge = {
  id: "prompt-injection-101-ab12cd",
  title: "Prompt Injection 101",
  category: "AI",
  description: "Get the model to reveal the flag.",
  points: 50,
  order: 1,
  mode: "flag",
  urlTemplate: "https://challenge.example/{token}",
};

const c2: AiChallenge = {
  id: "jailbreak-201-zz9kq2",
  title: "Jailbreak 201",
  category: "AI",
  description: "",
  points: 25,
  order: 2,
  mode: "event",
  urlTemplate: "https://challenge.example/launch?t={token}",
};

const row1: AdminAiChallenge = { challenge: c1, flag: "CTF{real}", hint: null, signingKey: "signkey-abc" };
const row2: AdminAiChallenge = { challenge: c2, flag: "", hint: null, signingKey: "signkey-xyz" };

function renderControls(initialChallenges: AdminAiChallenge[] = [], initialCategories: string[] = ["AI"], loaded = true) {
  return renderToStaticMarkup(
    <AdminAiControls
      initialLoaded={loaded}
      pending={false}
      aiCooldownSecInput="5"
      setAiCooldownSecInput={noop}
      commitNumber={noop}
      initialChallenges={initialChallenges}
      initialCategories={initialCategories}
    />,
  );
}

describe("AdminAiControls", () => {

  // Issue #331: an empty list and an unread one are different answers, and only
  // one of them means the organizer's content is gone. Every module tab used to
  // open by telling them it had — for 6-10 seconds on a real deployment.
  it("says Checking… while the first read is in flight, not that the board is empty", () => {
    const html = renderControls([], [], false);
    expect(html).toContain("Checking…");
    expect(html).not.toContain("No challenges yet.");
    expect(html).not.toContain("No categories yet");
  });
  it("renders the cooldown setting input with its current value", () => {
    const html = renderControls();
    expect(html).toContain("Submission cooldown (sec)");
    expect(html).toMatch(/value="5"/);
  });
  // #494: the cooldown is per contestant while points are per team.
  it("says on the cooldown that it is per contestant, not per team", () => {
    expect(renderControls()).toContain("Counted per contestant, not per team");
  });

  it("renders an Add challenge control and a placeholder when there are none", () => {
    const html = renderControls();
    expect(html).toContain("Add challenge");
    expect(html).toContain("No challenges yet.");
  });

  // "Renders the list from GET": `initialChallenges` IS what a first-paint
  // GET would seed this component with (see the component's own header
  // comment) — the mount-time fetch is untestable under
  // `renderToStaticMarkup`, so this is the same substitute classic's and
  // quiz's suites use.
  it("renders each challenge from the seeded list, with edit and delete controls, never the placeholder", () => {
    const html = renderControls([row1, row2]);
    expect(html).toContain(c1.title);
    expect(html).toContain(c2.title);
    expect(html).toContain("Edit");
    expect(html).toContain("Delete");
    expect(html).not.toContain("No challenges yet.");
  });

  it("shows each row's mode alongside its category and points", () => {
    const html = renderControls([row1, row2]);
    expect(html).toMatch(/Graded by flag/);
    expect(html).toMatch(/External event only/);
  });

  // The component HOLDS the flag and the signing key (that's the point — the
  // edit form prefills from the flag, and the integration panel reads the
  // signing key), but the collapsed list must not paint either: an
  // organizer browsing their challenges may well be doing it on a projector.
  it("keeps flags and signing keys out of the collapsed list markup", () => {
    const html = renderControls([row1]);
    expect(html).toContain(c1.title);
    expect(html).not.toContain(row1.flag);
    expect(html).not.toContain(row1.signingKey);
  });

  it("offers no id field in the collapsed view — ids are generated, never typed", () => {
    const html = renderControls([]);
    expect(html).not.toMatch(/name="id"/);
  });

  // Each row renders the integration panel (endpoints, masked signing key,
  // Rotate, test curl, Send test for event/both-mode challenges — see
  // admin-ai-integration.test.tsx's mode-gating coverage for the flag-mode
  // case) — but it still never leaks the launch URL TEMPLATE (an
  // authoring-time field, not part of the integration surface) or the RAW
  // signing key (masked by default; see admin-ai-integration.test.tsx for
  // that component's own masking coverage). row2 is event-mode, so Rotate
  // and Send test apply to it.
  it("renders the integration panel per row, without leaking the launch URL template or the raw signing key", () => {
    const html = renderControls([row2]);
    expect(html).toContain("Rotate");
    expect(html).toContain("Send test");
    expect(html).not.toContain(c2.urlTemplate);
    expect(html).not.toContain(row2.signingKey);
  });

  // c1 is flag-mode: the integration panel hides Rotate/Send test for it
  // (see admin-ai-integration.tsx's mode gating) but still shows the
  // endpoint URLs — an external site still submits typed flags with the
  // token.
  it("hides Rotate and Send test for a flag-mode row, but still shows the endpoint URLs", () => {
    const html = renderControls([row1]);
    expect(html).not.toContain(">Rotate<");
    expect(html).not.toContain(">Send test<");
    expect(html).toContain("/api/ai/submit");
    expect(html).not.toContain(c1.urlTemplate);
    expect(html).not.toContain(row1.signingKey);
  });

  describe("category editor", () => {
    it("renders the category list with move and remove controls", () => {
      const html = renderControls([], ["AI", "Prompting"]);
      expect(html).toContain("AI");
      expect(html).toContain("Prompting");
      expect(html).toContain("Add category");
      // Inline chips: move left/right.
      expect(html).toContain('aria-label="Move &quot;AI&quot; left"');
      expect(html).toContain('aria-label="Move &quot;Prompting&quot; right"');
      expect(html).toContain("Remove");
    });

    it("shows a placeholder and disables Add challenge when there are no categories", () => {
      const html = renderControls([], []);
      expect(html).toContain("No categories yet");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add challenge</);
    });
  });
});

describe("AiChallengeForm — masking, mode-gating and preview", () => {
  function renderForm(overrides: Partial<Parameters<typeof AiChallengeForm>[0]> = {}) {
    const editor = editorFromAiChallenge(row1);
    return renderToStaticMarkup(
      <AiChallengeForm
        editor={editor}
        categories={["AI"]}
        pending={false}
        error={null}
        flagRevealed={false}
        setFlagRevealed={noop}
        onChange={noop}
        onCancel={noop}
        onSubmit={noop}
        {...overrides}
      />,
    );
  }

  it("prefills the existing flag when editing a graded challenge, masked until revealed", () => {
    const html = renderForm();
    expect(html).toContain('type="password"');
    expect(html).toMatch(/value="CTF{real}"/);
    expect(html).toMatch(/reveal/i);
  });

  it("switches to a plain text input once revealed", () => {
    const html = renderForm({ flagRevealed: true });
    expect(html).toContain('type="text"');
    expect(html).not.toContain('type="password"');
    expect(html).toMatch(/hide/i);
  });

  // Delta 2 from classic: event mode hides/disables the flag AND
  // case-sensitivity inputs, replacing them with a one-line explanation.
  it("hides the flag input and the case-sensitive checkbox in event mode", () => {
    const html = renderToStaticMarkup(
      <AiChallengeForm
        editor={editorFromAiChallenge(row2)}
        categories={["AI"]}
        pending={false}
        error={null}
        flagRevealed={false}
        setFlagRevealed={noop}
        onChange={noop}
        onCancel={noop}
        onSubmit={noop}
      />,
    );
    expect(html).not.toContain('type="password"');
    // The exact reveal-toggle BUTTON, not merely the word "reveal" — the
    // hint field's own help text legitimately says "...pay the configured
    // hint cost to reveal it...", which must not make this assertion vacuous.
    expect(html).not.toMatch(/>Reveal</);
    expect(html).not.toContain("Case-sensitive flag");
    expect(html).toContain("Event-mode challenges take no flag — solves arrive from the external site.");
  });

  it("shows the flag input and case-sensitive checkbox for a flag-mode challenge", () => {
    const html = renderForm();
    expect(html).toContain("Case-sensitive flag");
    expect(html).not.toContain("Event-mode challenges take no flag");
  });

  // Delta 1: the launch URL is validated live with the SAME `validateUrlTemplate`
  // the store runs, and the reason renders inline.
  it("renders validateUrlTemplate's own reason inline for a bad launch URL", () => {
    const editor = editorFromAiChallenge({ ...row1, challenge: { ...c1, urlTemplate: "https://x.example/no-token" } });
    const html = renderToStaticMarkup(
      <AiChallengeForm
        editor={editor}
        categories={["AI"]}
        pending={false}
        error={null}
        flagRevealed={false}
        setFlagRevealed={noop}
        onChange={noop}
        onCancel={noop}
        onSubmit={noop}
      />,
    );
    expect(html).toContain("Template must contain {token}");
  });

  it("disables Save while the launch URL is invalid", () => {
    const editor = editorFromAiChallenge({ ...row1, challenge: { ...c1, urlTemplate: "not a url" } });
    const html = renderToStaticMarkup(
      <AiChallengeForm
        editor={editor}
        categories={["AI"]}
        pending={false}
        error={null}
        flagRevealed={false}
        setFlagRevealed={noop}
        onChange={noop}
        onCancel={noop}
        onSubmit={noop}
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save changes</);
  });

  it("offers no id input on a new challenge — the id is generated at save", () => {
    const html = renderToStaticMarkup(
      <AiChallengeForm
        editor={newAiChallengeEditor(1, "AI")}
        categories={["AI"]}
        pending={false}
        error={null}
        flagRevealed={false}
        setFlagRevealed={noop}
        onChange={noop}
        onCancel={noop}
        onSubmit={noop}
      />,
    );
    expect(html).not.toMatch(/<input[^>]*name="id"/);
    expect(html).toMatch(/generated from the title/i);
  });

  it("previews the description through the same renderer the board uses", () => {
    const editor = editorFromAiChallenge({ ...row1, challenge: { ...c1, description: "**b**" } });
    const html = renderToStaticMarkup(
      <AiChallengeForm
        editor={editor}
        categories={["AI"]}
        pending={false}
        error={null}
        flagRevealed={false}
        setFlagRevealed={noop}
        onChange={noop}
        onCancel={noop}
        onSubmit={noop}
      />,
    );
    expect(html).toMatch(/<strong[^>]*>b<\/strong>/);
  });
});

describe("draftFromAiChallenge", () => {
  it("prefills flag, mode, urlTemplate, title, category and description when editing", () => {
    const draft = draftFromAiChallenge(row1);
    expect(draft.flag).toBe(row1.flag);
    expect(draft.mode).toBe(c1.mode);
    expect(draft.urlTemplate).toBe(c1.urlTemplate);
    expect(draft.title).toBe(c1.title);
    expect(draft.category).toBe(c1.category);
    expect(draft.description).toBe(c1.description);
    expect(draft.points).toBe(String(c1.points));
    expect(draft.order).toBe(String(c1.order));
  });

  it("carries no id field for the form to change", () => {
    expect(Object.keys(draftFromAiChallenge(row1))).not.toContain("id");
    expect(Object.keys(emptyAiDraft())).not.toContain("id");
  });
});

describe("isAiDraftValid", () => {
  const base: AiChallengeDraft = { ...emptyAiDraft("AI", 1), title: "t", flag: "f", urlTemplate: "https://x.example/{token}" };

  it("accepts a fully-filled graded draft", () => {
    expect(isAiDraftValid(base)).toBe(true);
  });

  it("rejects a missing title", () => {
    expect(isAiDraftValid({ ...base, title: "" })).toBe(false);
    expect(isAiDraftValid({ ...base, title: "   " })).toBe(false);
  });

  it("rejects a missing category", () => {
    expect(isAiDraftValid({ ...base, category: "" })).toBe(false);
  });

  it("rejects a non-integer or out-of-range points value", () => {
    expect(isAiDraftValid({ ...base, points: "1.5" })).toBe(false);
    expect(isAiDraftValid({ ...base, points: "" })).toBe(false);
    expect(isAiDraftValid({ ...base, points: "-1" })).toBe(false);
  });

  it("rejects a negative or non-integer order", () => {
    expect(isAiDraftValid({ ...base, order: "-1" })).toBe(false);
    expect(isAiDraftValid({ ...base, order: "1.5" })).toBe(false);
    expect(isAiDraftValid({ ...base, order: "" })).toBe(false);
  });

  it("rejects a description longer than MARKDOWN_MAX", () => {
    expect(isAiDraftValid({ ...base, description: "x".repeat(4001) })).toBe(false);
  });

  // The exact deltas the brief calls out.
  it("rejects a launch URL missing the {token} placeholder", () => {
    expect(isAiDraftValid({ ...base, urlTemplate: "https://x.example/no-token" })).toBe(false);
  });

  it("rejects a flag-mode draft with no flag", () => {
    expect(isAiDraftValid({ ...base, mode: "flag", flag: "" })).toBe(false);
  });

  it("rejects a both-mode draft with no flag — both still grades by flag", () => {
    expect(isAiDraftValid({ ...base, mode: "both", flag: "" })).toBe(false);
  });

  it("accepts an event-mode draft with no flag", () => {
    expect(isAiDraftValid({ ...base, mode: "event", flag: "" })).toBe(true);
  });
});

// A challenge's id is the field name in `ctf:ai:challenges`, both flag
// hashes, and `ctf:ai:signkey` — AND the reference every contestant's
// `ctf:ai:solves:<login>` row and every external integration's signing key
// are pinned against. Change it on an existing challenge and both break.
describe("payloadFromAiEditor", () => {
  it("submits the stored id even when every other field has been rewritten", () => {
    const editor = editorFromAiChallenge(row1);
    const draft: AiChallengeDraft = {
      ...editor.draft,
      title: "A completely different title",
      points: "999",
      flag: "CTF{changed}",
    };
    const payload = payloadFromAiEditor({ ...editor, draft }, () => "generated-from-the-new-title");
    expect(payload.id).toBe(c1.id);
    expect(payload.title).toBe("A completely different title");
    expect(payload.points).toBe(999);
    expect(payload.flag).toBe("CTF{changed}");
  });

  it("generates an id from the title for a NEW challenge", () => {
    const editor = newAiChallengeEditor(4, "AI");
    const draft: AiChallengeDraft = { ...editor.draft, title: "Prompt Injection 101", flag: "CTF{x}", urlTemplate: "https://x.example/{token}" };
    const payload = payloadFromAiEditor({ ...editor, draft });
    expect(payload.id).toContain("prompt-injection-101");
    expect(payload.order).toBe(4);
  });

  it("carries exactly the wire contract's challenge keys for a graded challenge — secrets included alongside the public fields", () => {
    const payload = payloadFromAiEditor(editorFromAiChallenge(row1));
    expect(Object.keys(payload).sort()).toEqual(
      ["category", "description", "flag", "hint", "id", "mode", "order", "points", "title", "urlTemplate"].sort(),
    );
    // The two secrets, separate from (not merged into) the public fields.
    expect(payload.flag).toBe(row1.flag);
    expect(payload.hint).toBe(row1.hint ?? "");
  });

  it("omits the flag entirely for an event-mode draft — the store discards it regardless", () => {
    const payload = payloadFromAiEditor(editorFromAiChallenge(row2));
    expect(payload.mode).toBe("event");
    expect("flag" in payload).toBe(false);
    // The hint is still sent unconditionally — it is unrelated to mode.
    expect("hint" in payload).toBe(true);
  });

  it("omits caseSensitive when off, sends true when on for a graded challenge", () => {
    const editor = editorFromAiChallenge(row1);
    expect("caseSensitive" in payloadFromAiEditor({ ...editor, draft: { ...editor.draft, caseSensitive: false } })).toBe(false);
    expect(payloadFromAiEditor({ ...editor, draft: { ...editor.draft, caseSensitive: true } }).caseSensitive).toBe(true);
  });

  // An organizer who ticks case-sensitive while flag/both-mode, then flips to
  // event-mode, must not leave `caseSensitive: true` riding along with no
  // flag left for it to apply to — semantically orphaned in the stored
  // record.
  it("omits caseSensitive for an event-mode draft even when the checkbox was left on", () => {
    const editor = editorFromAiChallenge(row2);
    const payload = payloadFromAiEditor({ ...editor, draft: { ...editor.draft, mode: "event", caseSensitive: true } });
    expect(payload.mode).toBe("event");
    expect("caseSensitive" in payload).toBe(false);
  });
});

describe("categoryUsageCount", () => {
  it("counts exactly the challenges filed under a category", () => {
    expect(categoryUsageCount([row1, row2], "AI")).toBe(2);
    expect(categoryUsageCount([row1, row2], "Prompting")).toBe(0);
  });
});

describe("aiCategoriesRequestBody", () => {
  it("carries exactly one key, categories", () => {
    expect(Object.keys(aiCategoriesRequestBody(["AI"]))).toEqual(["categories"]);
  });
});

describe("describeAiError", () => {
  it("surfaces a 400 validation error as the store's own message", () => {
    expect(describeAiError(400, "Invalid challenge id: !!")).toBe("Invalid challenge id: !!");
  });

  it("surfaces a 503 infrastructure failure distinctly from a validation error", () => {
    const msg = describeAiError(503, "ai store write failed");
    expect(msg).not.toBe("ai store write failed");
    expect(msg).toMatch(/unavailable/i);
  });
});

describe("aiChallengeDeleteConfirm", () => {
  it("requires typing the challenge's own title to confirm — not a generic phrase", () => {
    const copy = aiChallengeDeleteConfirm(c1);
    expect(copy.requireType).toBe(c1.title);
    expect(copy.title).toContain(c1.title);
  });

  it("warns that the signing key is revoked, not just that the challenge disappears", () => {
    const { body } = aiChallengeDeleteConfirm(c1);
    expect(body).toMatch(/signing key/i);
    expect(body).toMatch(/points already banked.*(stay|remain)/i);
    expect(body).toMatch(/master reset/i);
  });

  it("never produces an empty requireType, even for a whitespace-only title", () => {
    const blank: AiChallenge = { ...c1, title: "   " };
    const copy = aiChallengeDeleteConfirm(blank);
    expect(copy.requireType.length).toBeGreaterThan(0);
    expect(copy.requireType).toBe(c1.id);
  });

  // THE gate this brief item asks for: rendering the REAL ConfirmModal with
  // the copy this function produces proves Confirm cannot be clicked before
  // the exact phrase is typed — `ConfirmModal`'s own `typed` state starts
  // empty, so its Confirm button is `disabled` on first render whenever
  // `requireType` is non-empty, with no click needed to prove it.
  it("renders the Delete-challenge confirm button disabled until the title is typed", () => {
    const copy = aiChallengeDeleteConfirm(c1);
    const html = renderToStaticMarkup(
      <ConfirmModal
        title={copy.title}
        body={copy.body}
        confirmLabel={copy.confirmLabel}
        requireType={copy.requireType}
        danger
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain(`Type <code`);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Delete challenge</);
  });
});

describe("commitAiCooldown", () => {
  it("commits under the exact key aiCooldownSec", () => {
    const spy = vi.fn();
    commitAiCooldown(spy, "10", noop);
    // The label rides along so a rejection is phrased through it (F2).
    expect(spy).toHaveBeenCalledWith("aiCooldownSec", "10", noop, "Submission cooldown (sec)");
  });
});

// Wire-contract test: drives `payloadFromAiEditor`'s output straight into the
// REAL `/api/admin/ai` route handler, with only the route's own dependencies
// (auth, the store, the audit pipeline) faked out. This is deliberately NOT a
// reimplementation of the route's secret-separation rule as a local
// assertion: it proves the actual server-side parser (`const { flag, hint,
// ...challenge } = parsed`, see route.ts) genuinely splits the two secrets
// out of the challenge record this component's payload builder sends.
// Mirrors admin-classic-controls.test.tsx's categories wire-contract test.
const {
  requireAdmin: wireRequireAdmin,
  upsertAiChallenge: wireUpsertAiChallenge,
  listAiChallengesForAdmin: wireListAiChallengesForAdmin,
  listAiCategories: wireListAiCategories,
  setAiCategories: wireSetAiCategories,
  deleteAiChallenge: wireDeleteAiChallenge,
  rotateAiSigningKey: wireRotateAiSigningKey,
  writeAdminAudit: wireWriteAdminAudit,
  AiValidationError: WireAiValidationError,
} = vi.hoisted(() => {
  class AiValidationError extends Error {
    field: string;
    constructor(field: string, message: string) {
      super(message);
      this.name = "AiValidationError";
      this.field = field;
    }
  }
  return {
    requireAdmin: vi.fn(),
    upsertAiChallenge: vi.fn(),
    listAiChallengesForAdmin: vi.fn(),
    listAiCategories: vi.fn(),
    setAiCategories: vi.fn(),
    deleteAiChallenge: vi.fn(),
    rotateAiSigningKey: vi.fn(),
    writeAdminAudit: vi.fn(),
    AiValidationError,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ requireAdmin: wireRequireAdmin }));
vi.mock("@/lib/ai-store", () => ({
  listAiChallengesForAdmin: wireListAiChallengesForAdmin,
  listAiCategories: wireListAiCategories,
  setAiCategories: wireSetAiCategories,
  upsertAiChallenge: wireUpsertAiChallenge,
  deleteAiChallenge: wireDeleteAiChallenge,
  rotateAiSigningKey: wireRotateAiSigningKey,
  AiValidationError: WireAiValidationError,
}));
vi.mock("@/lib/admin-store", () => ({
  writeAdminAudit: wireWriteAdminAudit,
  adminErrorLabel: (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "non-Error throw"),
}));

const { POST: wirePOST, DELETE: wireDELETE } = await import("@/app/api/admin/ai/route");

describe("challenge-upsert POST wire contract, proven against the real route", () => {
  beforeEach(() => {
    wireRequireAdmin.mockReset().mockResolvedValue({ ok: true, login: "alice" });
    wireUpsertAiChallenge.mockReset().mockImplementation(async (c: AiChallenge, secrets: { flag?: string; hint?: string }) => ({
      challenge: c,
      flag: secrets.flag ?? "",
      hint: secrets.hint ? secrets.hint : null,
      signingKey: "signkey-new",
    }));
    wireWriteAdminAudit.mockReset().mockResolvedValue(undefined);
  });

  const post = (body: unknown) =>
    wirePOST(new Request("http://x/api/admin/ai", { method: "POST", body: JSON.stringify(body) }));

  it("the exact body this component's create flow sends is accepted, with secrets split from the challenge record", async () => {
    const payload = payloadFromAiEditor(editorFromAiChallenge(row1));
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(wireUpsertAiChallenge).toHaveBeenCalledTimes(1);
    const [challengeArg, secretsArg] = wireUpsertAiChallenge.mock.calls[0];
    // The record handed to the store carries NEITHER secret...
    expect(challengeArg).not.toHaveProperty("flag");
    expect(challengeArg).not.toHaveProperty("hint");
    expect(challengeArg).toMatchObject({ id: c1.id, mode: "flag", urlTemplate: c1.urlTemplate });
    // ...they arrive in a SEPARATE object instead, matching this payload's
    // own secret fields exactly.
    expect(secretsArg).toEqual({ flag: payload.flag, hint: payload.hint });
  });

  it("the exact body this component sends for an event-mode challenge omits flag and caseSensitive, and is still accepted", async () => {
    // caseSensitive left ON from a prior flag/both-mode edit — the payload
    // builder must still drop it once mode is event, or it lands stored with
    // no flag left for it to apply to.
    const editor = editorFromAiChallenge(row2);
    const payload = payloadFromAiEditor({ ...editor, draft: { ...editor.draft, caseSensitive: true } });
    expect("caseSensitive" in payload).toBe(false);
    const res = await post(payload);
    expect(res.status).toBe(200);
    const [challengeArg, secretsArg] = wireUpsertAiChallenge.mock.calls[0];
    expect(secretsArg.flag).toBeUndefined();
    expect(challengeArg).not.toHaveProperty("caseSensitive");
  });
});

// F5: `rotateSigningKey` and `doDelete` (admin-ai-controls.tsx) build their
// request bodies inline — `{rotate: id}` and `{id}` respectively — rather
// than through an exported helper like `aiCategoriesRequestBody` or
// `payloadFromAiEditor`, so there is no pure function to unit-test. These
// cases instead drive the exact literal body each flow sends straight into
// the REAL route handlers, the same wire-contract idiom the upsert tests
// above use, proving the real `parseRotatePayload`/`DELETE` body parsing
// accepts it and calls the real store function with the right id.
describe("rotate and delete wire contract, proven against the real route", () => {
  beforeEach(() => {
    wireRequireAdmin.mockReset().mockResolvedValue({ ok: true, login: "alice" });
    wireRotateAiSigningKey.mockReset().mockResolvedValue("signkey-new");
    wireDeleteAiChallenge.mockReset().mockResolvedValue(undefined);
    wireWriteAdminAudit.mockReset().mockResolvedValue(undefined);
  });

  it("the rotate flow's exact body, {rotate: id}, is accepted and rotates that challenge's key", async () => {
    const res = await wirePOST(
      new Request("http://x/api/admin/ai", { method: "POST", body: JSON.stringify({ rotate: c1.id }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signingKey: "signkey-new" });
    expect(wireRotateAiSigningKey).toHaveBeenCalledWith(c1.id);
    expect(wireWriteAdminAudit).toHaveBeenCalledWith("alice", "ai-rotate-key", { id: c1.id });
  });

  it("the delete flow's exact body, {id}, is accepted and deletes that challenge", async () => {
    const res = await wireDELETE(
      new Request("http://x/api/admin/ai", { method: "DELETE", body: JSON.stringify({ id: c1.id }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(wireDeleteAiChallenge).toHaveBeenCalledWith(c1.id);
    expect(wireWriteAdminAudit).toHaveBeenCalledWith("alice", "ai-delete", { id: c1.id });
  });
});

// Same report as classic's, for the same checklist (see `ModuleInventory` in
// admin-module-setup.tsx).
describe("aiInventory", () => {
  it("counts challenges and categories separately", async () => {
    const { aiInventory } = await import("@/components/admin-ai-controls");
    expect(aiInventory([], ["Prompt Injection"])).toEqual({ items: 0, categories: 1, unlisted: 0 });
  });

  // The board this one feeds is the one #344 was reproduced on: three
  // authored AI challenges left the contestant board when the seed replaced
  // the category list, and the panel reported "1 category · 5 challenges".
  it("counts challenges the board will not render, on the same exact match", async () => {
    const { aiInventory } = await import("@/components/admin-ai-controls");
    // Both fixture rows are in "AI".
    expect(aiInventory([row1, row2], ["AI"]).unlisted).toBe(0);
    expect(aiInventory([row1, row2], ["Guardrails"]).unlisted).toBe(2);
    // Exact match, like classic's and like the board's own filter: "ai" is
    // not "AI", and a row under a spelling the list does not hold is one no
    // contestant can reach.
    expect(aiInventory([row1, row2], ["ai"]).unlisted).toBe(2);
  });
});

// UX audit F5: the module-wide endpoint URLs render ONCE above the list, and
// each row's integration panel is collapsed until opened, so the list an
// organizer scrolls to find a challenge is a list again.
describe("AdminAiControls — density", () => {
  it("renders the endpoint URLs once for the whole board, not once per row", async () => {
    const { default: Controls } = await import("@/components/admin-ai-controls");
    const html = renderToStaticMarkup(
      <Controls pending={false} aiCooldownSecInput="" setAiCooldownSecInput={noop} commitNumber={noop} initialChallenges={[row1, row2]} initialCategories={["AI"]} />,
    );
    // The endpoints block is rendered ONCE for the board, so its content must
    // not scale with the number of challenge rows. Asserting a fixed count
    // would only pin today's block; asserting that one row and two rows print
    // the same number pins the invariant the block exists for. (Each URL
    // appears twice within the block itself: the copyable row, and again
    // inside that endpoint's own demo request.)
    const oneRow = renderToStaticMarkup(
      <Controls pending={false} aiCooldownSecInput="" setAiCooldownSecInput={noop} commitNumber={noop} initialChallenges={[row1]} initialCategories={["AI"]} />,
    );
    const count = (s: string) => s.match(/\/api\/ai\/submit/g)?.length ?? 0;
    expect(count(html)).toBe(count(oneRow));
    expect(count(html)).toBeGreaterThan(0);
    // Two rows: one integration disclosure and one ⋯ actions menu each, plus
    // the board-level "Wiring the external site" drawer — all closed.
    // Two rows: one integration disclosure and one ⋯ actions menu each, plus
    // the board-level drawers — "Wiring the external site" and one demo per
    // endpoint — all closed.
    expect(html.match(/<details/g)?.length).toBe(8);
    expect(html.match(/Wiring the external site/g)?.length).toBe(1);
    expect(html.match(/what to send and what comes back/g)?.length).toBe(3);
    expect(html.match(/Integration —/g)?.length).toBe(2);
    expect(html).not.toContain("<details open");
  });
});
