// Same testing constraints as admin-ai-controls.test.tsx: this repo's vitest
// config runs in the `node` environment (no jsdom, no
// `@testing-library/react`), so no DOM event can ever be simulated —
// `renderToStaticMarkup` produces a plain HTML string, and `onClick`
// handlers are never serialized into it at all.
//
// `AiIntegrationPanel` is exported specifically so every visual state
// (masked/revealed, the rotate confirm open/closed, a specific Send test
// outcome) can be rendered DIRECTLY with that state as an explicit prop,
// the same way admin-ai-controls.test.tsx renders `AiChallengeForm` directly
// with `flagRevealed` set. The button-press LOGIC a click would otherwise
// trigger (`requestRotate`, `confirmRotate`, `fetchAiTest`,
// `classifyAiTestResponse`) is proven by calling those exported functions
// directly — mirrors `commitAiCooldown` in admin-ai-controls.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiChallenge } from "@/lib/ai-store";
import AdminAiIntegration, {
  AiEndpointsBlock,
  AiIntegrationPanel,
  ROTATE_CONSEQUENCE,
  classifyAiTestResponse,
  confirmRotate,
  fetchAiTest,
  requestRotate,
  testOutcomeHelp,
  testOutcomeTone,
  type AiIntegrationPanelProps,
} from "@/components/admin-ai-integration";

const CHALLENGE: AiChallenge = {
  id: "prompt-leak-ab12cd",
  title: "Prompt Leak",
  category: "AI",
  description: "d",
  points: 100,
  order: 1,
  mode: "event",
  urlTemplate: "https://challenge.example/{token}",
};

const REAL_KEY = "aik_" + "z".repeat(43);
const ORIGIN = "https://ctf.example.org";

const noop = () => {};

function panelProps(overrides: Partial<AiIntegrationPanelProps> = {}): AiIntegrationPanelProps {
  return {
    challenge: CHALLENGE,
    signingKey: REAL_KEY,
    origin: ORIGIN,
    pending: false,
    revealed: false,
    onToggleReveal: noop,
    rotateConfirmOpen: false,
    onRequestRotate: noop,
    onCancelRotate: noop,
    onConfirmRotate: noop,
    testPending: false,
    testOutcome: null,
    onSendTest: noop,
    ...overrides,
  };
}

function renderPanel(overrides: Partial<AiIntegrationPanelProps> = {}): string {
  return renderToStaticMarkup(<AiIntegrationPanel {...panelProps(overrides)} />);
}

/** `renderToStaticMarkup` HTML-entity-escapes the curl block's quotes and
 *  apostrophes (`"` → `&quot;`, `'` → `&#x27;`). Decoded back so a test can
 *  assert an EXACT shell substring — quotes and all — rather than working
 *  around the escaping with partial matches that would miss a mutation
 *  inside a quoted portion. Only the three entities this component's own
 *  output can ever contain; not a general HTML-entity decoder. */
function decodeCurlEntities(text: string): string {
  return text.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
}

function curlBlock(html: string): string {
  const match = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
  if (!match) throw new Error("no <pre> block found in rendered markup");
  return match[1];
}

/** Finds the `<button>` whose text is exactly `label` and returns whether it
 *  carries a real `disabled` attribute. NOT a substring check for the word
 *  "disabled" anywhere in the tag — this component's buttons use Tailwind's
 *  `disabled:opacity-50` variant in their `class`, which contains the
 *  literal substring "disabled" whether or not the attribute is present, so
 *  a naive `/disabled/` match would pass on every button regardless of its
 *  actual state. */
function isButtonDisabled(html: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<button([^>]*)>${escaped}<\\/button>`));
  if (!match) throw new Error(`no <button>${label}</button> found in rendered markup`);
  return /(^|\s)disabled(=|\s|$)/.test(match[1]);
}

describe("AiIntegrationPanel — signing key masking", () => {
  it("masks the key by default: the raw key is absent from markup, the placeholder is present", () => {
    const html = renderPanel({ revealed: false });
    expect(html).not.toContain(REAL_KEY);
    expect(html).toContain("aik_…");
  });

  it("reveals the key when `revealed` is true, and the placeholder no longer stands in for it", () => {
    const html = renderPanel({ revealed: true });
    expect(html).toContain(REAL_KEY);
  });
});

describe("AiIntegrationPanel — test curl", () => {
  it("masked: the curl's KEY line shows the placeholder, never the real key", () => {
    const html = renderPanel({ revealed: false });
    const curl = curlBlock(html);
    expect(curl).toContain("KEY=&#x27;aik_…&#x27;");
    expect(curl).not.toContain(REAL_KEY);
  });

  it("revealed: the curl contains the real key exactly once", () => {
    const html = renderPanel({ revealed: true });
    const curl = curlBlock(html);
    const occurrences = curl.split(REAL_KEY).length - 1;
    expect(occurrences).toBe(1);
  });

  it("the curl's POST target and challengeId use the real origin and challenge id", () => {
    const html = renderPanel({ revealed: true });
    const curl = curlBlock(html);
    expect(curl).toContain(`${ORIGIN}/api/ai/event`);
    // The rendered markup HTML-entity-escapes quotes (&quot;), so this checks
    // the un-escaped substrings the curl's JSON body is built from rather
    // than a literal `"challengeId":"..."` slice.
    expect(curl).toContain("challengeId");
    expect(curl).toContain(CHALLENGE.id);
  });

  it("the TOKEN stays a placeholder with the caption pointing at Send test", () => {
    const html = renderPanel({ revealed: true });
    const curl = curlBlock(html);
    expect(curl).toContain("TOKEN=&#x27;eyJ…&#x27;");
    expect(html).toContain("Use Send test below for a server-minted token, or copy a token from your own launcher link.");
  });
});

// Pins the curl's load-bearing recipe. Prior coverage only proved
// origin/challengeId/KEY/TOKEN/caption substitution — nothing asserted the
// FORMULA itself (the header names, the `printf`-then-`openssl` signature
// pipeline, the algorithm name), so a mutation inside that fixed scaffolding
// (e.g. `sha256=$SIG` → `sha1=$SIG` in the signature header, which does not
// match what `SIG` was actually computed with) left every prior test green
// while shipping organizers a broken integration recipe. Each assertion
// below checks an EXACT substring of the DECODED curl text (see
// `decodeCurlEntities`), so a one-character drift anywhere in the formula
// fails here specifically, not just "the block changed somehow".
describe("AiIntegrationPanel — curl signature formula (pins the load-bearing recipe)", () => {
  it("computes TS from the current time, unquoted", () => {
    const curl = decodeCurlEntities(curlBlock(renderPanel({ revealed: true })));
    expect(curl).toContain("TS=$(date +%s)");
  });

  it("signs over TS and BODY with printf, exactly as openssl expects them", () => {
    const curl = decodeCurlEntities(curlBlock(renderPanel({ revealed: true })));
    expect(curl).toContain(`printf '%s.%s' "$TS" "$BODY"`);
  });

  it("HMACs with sha256, keyed on $KEY", () => {
    const curl = decodeCurlEntities(curlBlock(renderPanel({ revealed: true })));
    expect(curl).toContain(`openssl dgst -sha256 -hmac "$KEY"`);
  });

  it("sends the timestamp header with the real header name", () => {
    const curl = decodeCurlEntities(curlBlock(renderPanel({ revealed: true })));
    expect(curl).toContain("X-CTF-Timestamp: $TS");
  });

  it("sends the signature header with the sha256= prefix that matches how SIG was actually computed", () => {
    const curl = decodeCurlEntities(curlBlock(renderPanel({ revealed: true })));
    // This is the exact assertion a `sha256=$SIG` → `sha1=$SIG` mutation in
    // the component must fail: the header's algorithm label has to match
    // the `-sha256` the SIG variable above was actually computed with, or
    // the snippet signs correctly and then tells the reader the wrong thing
    // about what it signed with.
    expect(curl).toContain("X-CTF-Signature: sha256=$SIG");
  });

  it('the dry-run body flag renders as "dryRun":true, however the BODY line assembles it', () => {
    const curl = decodeCurlEntities(curlBlock(renderPanel({ revealed: true })));
    expect(curl).toContain(`"dryRun":true`);
  });
});

// UX audit F5: the three endpoint URLs are module-wide, but rendered inside
// every challenge row — three challenges printed them twelve times, at 542 px
// a row. They now live in `AiEndpointsBlock`, rendered ONCE above the list by
// admin-ai-controls.tsx, and the per-row panel no longer carries them.
describe("AiEndpointsBlock", () => {
  it("renders the three endpoint URLs with the given origin", () => {
    const html = renderToStaticMarkup(<AiEndpointsBlock origin={ORIGIN} />);
    expect(html).toContain(`${ORIGIN}/api/ai/submit`);
    expect(html).toContain(`${ORIGIN}/api/ai/event`);
    expect(html).toContain(`${ORIGIN}/api/ai/state`);
    expect(html).toContain("same for every challenge");
  });

  it("a different origin changes all three — not hard-coded to one host", () => {
    const html = renderToStaticMarkup(<AiEndpointsBlock origin="http://localhost:3000" />);
    expect(html).toContain("http://localhost:3000/api/ai/submit");
    expect(html).not.toContain(`${ORIGIN}/api/ai/submit`);
  });
});

describe("AiIntegrationPanel — density", () => {
  it("no longer repeats the endpoint URLs per row", () => {
    expect(renderPanel()).not.toContain("/api/ai/submit");
  });

  it("is collapsed by default, with a summary that names what is inside", () => {
    const html = renderPanel();
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Integration");
    expect(html).toContain("signing key");
  });

  it("flag-mode: the summary says the integration panel is not needed", () => {
    const html = renderPanel({ challenge: { ...CHALLENGE, mode: "flag" } });
    expect(html).toContain("<details");
    expect(html).toMatch(/graded by flag/);
  });
});

// F2: the signing key / Rotate / test curl / Send test are all meaningless
// for a `mode: "flag"` challenge — the event route refuses it outright with
// `wrong-mode` (see ai-store.ts's AWARD_SCRIPT). The endpoint URLs still
// matter (an external site still submits typed flags with the token), so
// only that section — plus a note pointing the key/Send-test at event-mode
// challenges — should render.
describe("AiIntegrationPanel — mode gating", () => {
  const FLAG_CHALLENGE: AiChallenge = { ...CHALLENGE, mode: "flag" };

  it("flag-mode: hides the signing key, Rotate, test curl, and Send test", () => {
    const html = renderPanel({ challenge: FLAG_CHALLENGE, revealed: true });
    expect(html).not.toContain("Signing key");
    expect(html).not.toContain("Reveal");
    expect(html).not.toContain(">Rotate<");
    expect(html).not.toContain("Test curl");
    expect(html).not.toContain(">Send test<");
    expect(html).not.toContain(REAL_KEY);
  });

  it("flag-mode: carries no endpoint URLs either — they live in AiEndpointsBlock, once", () => {
    const html = renderPanel({ challenge: FLAG_CHALLENGE });
    expect(html).not.toContain("/api/ai/submit");
  });

  it("flag-mode: shows a note pointing the signing key and Send test at event-mode challenges", () => {
    const html = renderPanel({ challenge: FLAG_CHALLENGE });
    expect(html).toContain("event-mode challenges");
  });

  it("event-mode: unchanged — signing key, Rotate, test curl, and Send test all still render", () => {
    const html = renderPanel({ challenge: { ...CHALLENGE, mode: "event" } });
    expect(html).toContain("Signing key");
    expect(html).toContain(">Rotate<");
    expect(html).toContain("Test curl");
    expect(html).toContain(">Send test<");
  });

  it("both-mode: unchanged — signing key, Rotate, test curl, and Send test all still render", () => {
    const html = renderPanel({ challenge: { ...CHALLENGE, mode: "both" } });
    expect(html).toContain("Signing key");
    expect(html).toContain(">Rotate<");
    expect(html).toContain("Test curl");
    expect(html).toContain(">Send test<");
  });
});

describe("AiIntegrationPanel — rotate confirm", () => {
  it("closed by default: the confirm's consequence sentence is not in the markup", () => {
    const html = renderPanel({ rotateConfirmOpen: false });
    expect(html).not.toContain(ROTATE_CONSEQUENCE);
  });

  it("open: renders the exact, verbatim consequence sentence", () => {
    const html = renderPanel({ rotateConfirmOpen: true });
    expect(html).toContain(ROTATE_CONSEQUENCE);
  });
});

describe("requestRotate / confirmRotate — the rotate button never fires onRotate directly", () => {
  it("requestRotate opens the confirm and never touches onRotate", () => {
    const setOpen = vi.fn();
    requestRotate(setOpen);
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("confirmRotate is the only path that calls onRotate, and closes the confirm once it resolves", async () => {
    const onRotate = vi.fn().mockResolvedValue(undefined);
    const setOpen = vi.fn();
    await confirmRotate(onRotate, setOpen);
    expect(onRotate).toHaveBeenCalledTimes(1);
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it("a rejected onRotate leaves the confirm open rather than closing it", async () => {
    const onRotate = vi.fn().mockRejectedValue(new Error("rotate failed"));
    const setOpen = vi.fn();
    await confirmRotate(onRotate, setOpen);
    expect(onRotate).toHaveBeenCalledTimes(1);
    expect(setOpen).not.toHaveBeenCalled();
  });
});

describe("AdminAiIntegration — mounting alone never fires onRotate", () => {
  it("a plain render calls onRotate zero times", () => {
    const onRotate = vi.fn().mockResolvedValue(undefined);
    renderToStaticMarkup(
      <AdminAiIntegration challenge={CHALLENGE} signingKey={REAL_KEY} onRotate={onRotate} pending={false} />,
    );
    expect(onRotate).not.toHaveBeenCalled();
  });

  it("a plain render masks the key (the default component never reveals on mount)", () => {
    const html = renderToStaticMarkup(
      <AdminAiIntegration challenge={CHALLENGE} signingKey={REAL_KEY} onRotate={vi.fn()} pending={false} />,
    );
    expect(html).not.toContain(REAL_KEY);
  });
});

describe("classifyAiTestResponse", () => {
  it("wouldAward: true → award", () => {
    const outcome = classifyAiTestResponse(true, {
      status: 200,
      body: { dryRun: true, wouldAward: true, verdict: "would-award", checks: [] },
    });
    expect(outcome).toEqual({ kind: "award" });
  });

  it("a relayed wrong-mode refusal (200 from the admin route, 409 relayed inside) → named wrong-mode, not award", () => {
    const outcome = classifyAiTestResponse(true, { status: 409, body: { error: "wrong-mode" } });
    expect(outcome).toEqual({ kind: "named", label: "wrong-mode" });
  });

  it("a 429 from the admin route itself (not a relay) → named rate-limited", () => {
    const outcome = classifyAiTestResponse(false, { error: "rate-limited" });
    expect(outcome).toEqual({ kind: "named", label: "rate-limited" });
  });

  it("a dry run that would refuse (not award) is named by its verdict, not treated as an award", () => {
    const outcome = classifyAiTestResponse(true, {
      status: 200,
      body: { dryRun: true, wouldAward: false, verdict: "would-refuse", checks: [] },
    });
    expect(outcome).toEqual({ kind: "named", label: "would-refuse" });
  });
});

describe("fetchAiTest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts exactly {challengeId} to /api/admin/ai/test and classifies a wouldAward response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 200, body: { dryRun: true, wouldAward: true, verdict: "would-award", checks: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchAiTest(CHALLENGE.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/ai/test");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ challengeId: CHALLENGE.id });
    expect(outcome).toEqual({ kind: "award" });
  });

  it("a 429 from the route surfaces as a named rate-limited outcome, not an award", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: "rate-limited" }) }),
    );
    const outcome = await fetchAiTest(CHALLENGE.id);
    expect(outcome).toEqual({ kind: "named", label: "rate-limited" });
  });

  it("a network failure is a named unavailable outcome, not a thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const outcome = await fetchAiTest(CHALLENGE.id);
    expect(outcome).toEqual({ kind: "named", label: "unavailable" });
  });

  // A challenge with no signing key yet minted (route.ts's own refusal — see
  // that file's header comment) previously only flowed through the generic
  // "some named error" branch, untested by its own slug. Named specifically
  // here so a future change that folds it into a vaguer message is caught.
  it('a 400 no-signing-key refusal is classified AND rendered by its exact slug — not a generic message', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "no-signing-key" }) }),
    );
    const outcome = await fetchAiTest(CHALLENGE.id);
    expect(outcome).toEqual({ kind: "named", label: "no-signing-key" });
    const html = renderPanel({ testOutcome: outcome });
    expect(html).toContain("Test result: no-signing-key");
    expect(html).not.toContain("Would award");
  });
});

describe("AiIntegrationPanel — Send test rendering", () => {
  it("no outcome yet: neither the award line nor a named-result line is rendered", () => {
    const html = renderPanel({ testOutcome: null });
    expect(html).not.toContain("Would award");
    expect(html).not.toContain("Test result:");
  });

  it("wouldAward outcome renders a clear, green would-award success line", () => {
    const html = renderPanel({ testOutcome: { kind: "award" } });
    expect(html).toContain("Would award");
    expect(html).not.toContain("Test result:");
  });

  // Was: "a named refusal (e.g. wrong-mode) names the slug" — pinned against
  // the default (event-mode) CHALLENGE fixture, but the real `/api/ai/event`
  // handler only ever returns `wrong-mode` for a `mode: "flag"` challenge
  // (see ai-store.ts's AWARD_SCRIPT), and a flag-mode challenge no longer
  // renders Send test at all (see the mode-gating describe block below) — so
  // this outcome can never actually reach this render path anymore.
  // Repurposed to a reachable refusal instead: a named refusal that is NOT
  // wrong-mode (e.g. a dry run that fails a different check) still renders
  // by its exact slug and is never mistaken for an award.
  it("a named refusal names the slug, and is NOT rendered as an award", () => {
    const html = renderPanel({ testOutcome: { kind: "named", label: "would-refuse" } });
    expect(html).toContain("Test result: would-refuse");
    expect(html).not.toContain("Would award");
  });

  it("a named rate-limited result names the slug", () => {
    const html = renderPanel({ testOutcome: { kind: "named", label: "rate-limited" } });
    expect(html).toContain("Test result: rate-limited");
  });

  // admin-redesign.md § Controls: green for solved / would-award, red only
  // for a refused or failed test. "Test result: solved" used to be red.
  it("colours a solve green and a refusal red", () => {
    expect(testOutcomeTone({ kind: "award" })).toBe("good");
    expect(testOutcomeTone({ kind: "named", label: "solved" })).toBe("good");
    expect(testOutcomeTone({ kind: "named", label: "would-award" })).toBe("good");
    expect(testOutcomeTone({ kind: "named", label: "would-refuse" })).toBe("bad");
    expect(testOutcomeTone({ kind: "named", label: "unavailable" })).toBe("bad");
    expect(renderPanel({ testOutcome: { kind: "named", label: "solved" } })).toMatch(/text-\[#22c55e\][^>]*>Test result: solved/);
    expect(renderPanel({ testOutcome: { kind: "named", label: "would-refuse" } })).toMatch(/text-\[#e53e3e\][^>]*>Test result: would-refuse/);
  });

  // Audit F22: the decoder ring for these verdicts lived in
  // docs/operations.md and nowhere on the panel, so a dry run answering
  // `no-team` looked like an integration fault when it means the organizer is
  // simply not on a team.
  it("explains the three refusals that are not faults", () => {
    for (const label of ["paused", "solved", "no-team"]) {
      expect(testOutcomeHelp(label)).toMatch(/^Not a fault/);
    }
  });

  it("explains the three that ARE something to fix", () => {
    expect(testOutcomeHelp("unavailable")).toMatch(/Try again/);
    expect(testOutcomeHelp("wrong-mode")).toMatch(/flag-only/);
    expect(testOutcomeHelp("no-signing-key")).toMatch(/Rotate/);
  });

  it("says nothing at all for a verdict this build has never seen", () => {
    // The route relays the event handler's verdict verbatim, so a newer
    // handler can hand back a string this build does not know. Inventing an
    // explanation for it would be worse than showing the bare name.
    expect(testOutcomeHelp("some-future-verdict")).toBeNull();
  });

  it("renders the sentence under the raw name, keeping both", () => {
    // The name is what the docs and any issue thread index; the sentence is
    // what it means here, now.
    const html = renderPanel({ testOutcome: { kind: "named", label: "no-team" } });
    expect(html).toContain("Test result: no-team");
    expect(html).toContain("you are not on a team");
  });

  it("styles Rotate amber, not red, and its confirm without the danger accent — rotating is recoverable", () => {
    const html = renderPanel({ rotateConfirmOpen: true });
    expect(html).toMatch(/<button[^>]*text-\[#d4a017\][^>]*>Rotate</);
    expect(html).not.toMatch(/<button[^>]*text-\[#e53e3e\][^>]*>Rotate</);
    expect(html).not.toContain("bg-[#e53e3e]");
  });

  it("Send test is disabled while `pending`", () => {
    const html = renderPanel({ pending: true, testPending: false });
    expect(isButtonDisabled(html, "Send test")).toBe(true);
  });

  it("Send test is enabled when neither pending nor testPending", () => {
    const html = renderPanel({ pending: false, testPending: false });
    expect(isButtonDisabled(html, "Send test")).toBe(false);
  });

  it("Send test is disabled while a test is in flight (testPending)", () => {
    const html = renderPanel({ pending: false, testPending: true });
    expect(html).toContain("Sending…");
    expect(isButtonDisabled(html, "Sending…")).toBe(true);
  });
});

describe("AiIntegrationPanel — rotate button disabled while pending", () => {
  it("disabled while pending", () => {
    const html = renderPanel({ pending: true });
    expect(isButtonDisabled(html, "Rotate")).toBe(true);
  });

  it("enabled when not pending", () => {
    const html = renderPanel({ pending: false });
    expect(isButtonDisabled(html, "Rotate")).toBe(false);
  });
});
