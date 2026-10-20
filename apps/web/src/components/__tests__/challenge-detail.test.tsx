// The challenge page's interactive surface — the card, form, cooldown and
// result-line logic that moved off the board (issue #208). These are the old
// board suite's card pins, ported with the component: the states, the #126
// ordering, and the flag-leak guard follow the form wherever it lives.
//
// @testing-library/react is not a dependency of this repo and must not be
// added just for this test; renderToStaticMarkup is enough. useRouter is
// mocked since next/navigation's real hook needs a router context. Anything
// gated behind a useState toggle never appears in a static render — these
// tests assert on the initial server-derived view, and drive `feedback`
// through the ChallengeCard prop where ordering matters.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import ChallengeDetail, {
  ChallengeCard,
  describeCorrect,
  describeIncorrect,
  describeRefusal,
  dispatchSubmit,
  resultLine,
  type ClassicChallengeView,
  type Feedback,
} from "@/components/challenge-detail";

const web: ClassicChallengeView = {
  id: "web-sqli-101",
  title: "SQLi 101",
  category: "Web",
  description: "Find the flag hidden behind a login form.",
  points: 50,
  teamsSolved: 3,
  status: "unsolved",
};

describe("ChallengeDetail", () => {
  it("renders the description through the markdown renderer", () => {
    const html = renderToStaticMarkup(
      <ChallengeDetail challenge={{ ...web, description: "**bold**" }} authenticated submitPath="/api/classic/submit" />,
    );
    expect(html).toMatch(/<strong[^>]*>bold<\/strong>/);
  });

  it("shows a solved challenge without a submit control", () => {
    const html = renderToStaticMarkup(
      <ChallengeDetail challenge={{ ...web, status: "solved", earnedPoints: 50 }} authenticated submitPath="/api/classic/submit" />,
    );
    expect(html).toMatch(/solved/i);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
  });

  // The retry instant is never printed: it renders as a live countdown that
  // starts after hydration, so the server render shows a time-free
  // placeholder. Reading a clock during render trips a hydration mismatch.
  it("shows a cooldown without leaking the raw instant", () => {
    const retryAt = "2026-08-19T12:34:56.000Z";
    const html = renderToStaticMarkup(
      <ChallengeDetail challenge={{ ...web, status: "cooldown", retryAt }} authenticated submitPath="/api/classic/submit" />,
    );
    expect(html).not.toContain(retryAt);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(html).toMatch(/cooldown/i);
  });

  it("shows the case-sensitive badge only when the challenge carries it", () => {
    const on = renderToStaticMarkup(
      <ChallengeDetail challenge={{ ...web, caseSensitive: true }} authenticated submitPath="/api/classic/submit" />,
    );
    const off = renderToStaticMarkup(<ChallengeDetail challenge={web} authenticated submitPath="/api/classic/submit" />);
    expect(on).toMatch(/case-sensitive/i);
    expect(off).not.toMatch(/case-sensitive/i);
  });

  it("prompts a signed-out visitor to sign in instead of offering a submit control", () => {
    const html = renderToStaticMarkup(<ChallengeDetail challenge={web} authenticated={false} submitPath="/api/classic/submit" />);
    expect(html).toMatch(/sign in with github/i);
    expect(html).not.toContain("<button");
  });

  it("never lets a flag reach the markup, even if props carried a leaked field", () => {
    const leaked = { ...web, flag: "CTF{leaked}", flagnorm: "ctf{leaked}" } as unknown as ClassicChallengeView;
    const html = renderToStaticMarkup(<ChallengeDetail challenge={leaked} authenticated submitPath="/api/classic/submit" />);
    expect(html).not.toContain("CTF{leaked}");
    expect(html).not.toContain("ctf{leaked}");
  });
});

describe("resultLine", () => {
  const solved: ClassicChallengeView = { ...web, status: "solved", earnedPoints: 50 };

  it("states a solved challenge's award once, from the durable status", () => {
    expect(resultLine(solved, undefined)).toEqual({ kind: "success", text: "Solved — earned 50 points." });
    expect(resultLine({ ...solved, earnedPoints: 1 }, undefined)?.text).toBe("Solved — earned 1 point.");
  });

  // The duplicate this exists to prevent: a fresh submission's feedback and
  // the refreshed solved status both announcing the same points.
  it("returns the fresh feedback INSTEAD of the status line, never both", () => {
    const fresh: Feedback = { kind: "success", text: "Correct — +50 points." };
    expect(resultLine(solved, fresh)).toEqual(fresh);
  });

  it("has nothing to say about an unsolved challenge with no feedback", () => {
    expect(resultLine(web, undefined)).toBeNull();
  });

  it("passes a refusal or a wrong answer straight through", () => {
    const wrong: Feedback = { kind: "error", text: "Not quite. Try again." };
    expect(resultLine(web, wrong)).toEqual(wrong);
  });
});

describe("describeCorrect", () => {
  it("celebrates a fresh solve with its points", () => {
    expect(describeCorrect(50)).toBe("Correct — +50 points.");
    expect(describeCorrect(1)).toBe("Correct — +1 point.");
  });

  it("explains an idempotent re-submission instead of announcing +0", () => {
    expect(describeCorrect(0, true)).toBe("You already solved this one — those points are already yours.");
  });
});

// #126, mirroring quiz-board.test.tsx. The two surfaces mirror each other
// deliberately, so a fix applied to one and not the other is the regression
// — this test is what makes that true rather than aspirational.
//
// Driven through ChallengeCard with a `feedback` prop: resultLine returns
// null for a cooldown challenge until a submission produces feedback, and
// feedback is client state a static render cannot drive.
describe("outcome ordering (#126)", () => {
  it("puts the outcome before its consequence, and both above the form", () => {
    const cooling: ClassicChallengeView = {
      ...web,
      status: "cooldown",
      retryAt: "2026-08-18T12:34:56.000Z",
    };
    const html = renderToStaticMarkup(
      <ChallengeCard
        challenge={cooling}
        authenticated
        value=""
        pending={false}
        feedback={{ kind: "error", text: "Not quite." }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const outcomeAt = html.indexOf("Not quite.");
    const cooldownAt = html.indexOf("On cooldown");
    const formAt = html.indexOf("<input");
    expect(outcomeAt).toBeGreaterThan(-1);
    expect(cooldownAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(outcomeAt).toBeLessThan(cooldownAt);
    expect(cooldownAt).toBeLessThan(formAt);
  });
});

// The transport split (spec §6.1's 2026-09-02 amendment). Classic POSTs to a
// route; ai calls a Server Action, because `/api/ai/submit` authenticates a
// launch token this component must never hold. `dispatchSubmit` is the whole
// of that difference, and the pin that matters is the NEGATIVE one: with an
// action in hand, nothing is fetched at all — a component that still fetched
// would reach a route that reads `{token, flag}` and 400s on this body, which
// is exactly the dead form this replaced.
describe("dispatchSubmit", () => {
  it("calls the server action with the flag, and never fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const action = vi.fn().mockResolvedValue({ correct: true, points: 40, already: false });
    try {
      const out = await dispatchSubmit("a1", "CTF{x}", { submitAction: action });
      expect(action).toHaveBeenCalledWith("CTF{x}");
      expect(action).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out).toEqual({ ok: true, data: { correct: true, points: 40, already: false } });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reads an action's refusal as not-ok, so the refusal copy path runs", async () => {
    const action = vi.fn().mockResolvedValue({ error: "cooldown", retryAt: "2026-09-02T00:00:00.000Z" });
    const out = await dispatchSubmit("a1", "CTF{x}", { submitAction: action });
    expect(out.ok).toBe(false);
    expect(out.data).toEqual({ error: "cooldown", retryAt: "2026-09-02T00:00:00.000Z" });
  });

  // Classic's path, byte for byte what it always sent.
  it("POSTs {challengeId, flag} to submitPath when there is no action", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ correct: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    try {
      const out = await dispatchSubmit("web-sqli-101", "CTF{y}", { submitPath: "/api/classic/submit" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/classic/submit");
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ challengeId: "web-sqli-101", flag: "CTF{y}" }));
      expect(out).toEqual({ ok: true, data: { correct: false } });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reports a non-2xx route response as not-ok, tolerating an unparseable body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 503 }));
    try {
      const out = await dispatchSubmit("web-sqli-101", "CTF{y}", { submitPath: "/api/classic/submit" });
      expect(out).toEqual({ ok: false, data: {} });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// Every reason the in-box form can now put in front of a contestant gets its
// own sentence rather than the generic fallback. The ai action passes the
// store's own `AiSubmitResult` reasons straight through
// (ai/[id]/actions.ts), so this list is that union plus classic's `no-team`.
describe("describeRefusal", () => {
  const generic = "That submission wasn't accepted.";

  it("names every reason the in-box form can receive", () => {
    for (const reason of [
      "paused",
      "solved",
      "cooldown",
      "unavailable",
      "no-team",
      "unauthorized",
      "not-launched",
      "locked",
      "wrong-mode",
      "invalid",
      "error",
    ]) {
      expect(describeRefusal(reason)).not.toBe(generic);
    }
  });

  it("falls back for anything it does not recognise", () => {
    expect(describeRefusal("something-new")).toBe(generic);
  });

  // #567: after the scheduled end the server answers `ended`, not `paused`.
  // The copy must say the event is over — no "try again later", which is
  // the pause's promise and false once the end has passed.
  it("names the end of the event as final, not as a pause", () => {
    expect(describeRefusal("ended")).not.toBe(generic);
    expect(describeRefusal("ended")).toMatch(/ended|over|closed/i);
    expect(describeRefusal("ended")).not.toMatch(/try again/i);
    expect(describeRefusal("ended")).not.toBe(describeRefusal("paused"));
  });

  // Reachable, unlike `gate`: a session can expire while the page stays open,
  // and the action's own session re-check (ai/[id]/actions.ts) then returns
  // this slug for a submit made from an already-rendered form. Names the fix
  // (sign in again), not just that something went wrong.
  it("tells an expired session to sign in again, by name", () => {
    expect(describeRefusal("unauthorized")).toBe("Your session expired — sign in and try again.");
  });
});

describe("dry-run result copy (#464 admin preview)", () => {
  it("says a preview grade recorded nothing, right or wrong", () => {
    expect(describeCorrect(50, false, true)).toBe("Correct — preview only, nothing was recorded (+50 once the event launches).");
    expect(describeIncorrect(true)).toBe("Not quite — preview only, nothing was recorded.");
    expect(describeIncorrect(false)).toBe("Not quite.");
  });
});

// #595: the detail page uses the board's figure, teams.
describe("ChallengeDetail solve count", () => {
  it("says how many teams solved it", () => {
    const html = renderToStaticMarkup(<ChallengeDetail challenge={web} authenticated submitPath="/api/classic/submit" />);
    expect(html).toContain("3 teams solved");
    expect(html).not.toContain("3 solves");
  });

  it("names one team in the singular, and says nothing when the count is unknown", () => {
    expect(renderToStaticMarkup(<ChallengeDetail challenge={{ ...web, teamsSolved: 1 }} authenticated submitPath="/api/classic/submit" />)).toContain(
      "1 team solved",
    );
    expect(renderToStaticMarkup(<ChallengeDetail challenge={{ ...web, teamsSolved: null }} authenticated submitPath="/api/classic/submit" />)).not.toMatch(
      /teams? solved/,
    );
  });
});
