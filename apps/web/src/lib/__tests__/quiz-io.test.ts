import { describe, expect, it } from "vitest";
import { QUIZ_POINTS_MAX } from "@/lib/quiz-keys";
import { parseBundle, serializeBundle, type QuizBundle } from "@/lib/quiz-io";

const valid: QuizBundle = {
  version: 1,
  questions: [
    {
      id: "clickjacking-ab12cd",
      prompt: "Which HTTP header mitigates clickjacking?",
      type: "single",
      choices: [
        { id: "a", label: "X-Frame-Options" },
        { id: "b", label: "Content-Length" },
      ],
      points: 10,
      order: 0,
      correct: ["a"],
    },
    {
      id: "injection-ef34gh",
      prompt: "Which of these are injection risks?",
      type: "multi",
      choices: [
        { id: "a", label: "String-concatenated SQL" },
        { id: "b", label: "Parameterized queries" },
        { id: "c", label: "eval() on user input" },
      ],
      points: 15,
      order: 1,
      correct: ["a", "c"],
    },
  ],
};

/** One question from `valid`, with `patch` applied — so each case below
 *  changes exactly the field it is about and everything else stays known
 *  good. */
function withQuestion(patch: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, questions: [{ ...valid.questions[0], ...patch }] });
}

function errorsOf(raw: string): { where: string; message: string }[] {
  const res = parseBundle(raw);
  if (res.ok) throw new Error("expected the bundle to be rejected, but it parsed");
  return res.errors;
}

describe("parseBundle", () => {
  it("accepts a well-formed bundle", () => {
    expect(parseBundle(JSON.stringify(valid))).toEqual({ ok: true, bundle: valid });
  });

  it("round-trips its own serialization", () => {
    const res = parseBundle(serializeBundle(valid));
    if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res.errors)}`);
    expect(res.bundle).toEqual(valid);
  });

  // V8's JSON.parse message embeds a verbatim excerpt of the offending text,
  // and in a quiz bundle that text can be an answer. Nothing from the input
  // may reach the response.
  it("reports malformed JSON as one generic error, echoing nothing back", () => {
    const errors = errorsOf('{"questions": [{"correct": ["the-secret-answer-id"');
    expect(errors).toHaveLength(1);
    expect(errors[0].where).toBe("(document)");
    expect(JSON.stringify(errors)).not.toContain("the-secret-answer-id");
  });

  it("rejects an unknown version rather than misparsing it", () => {
    const errors = errorsOf(JSON.stringify({ ...valid, version: 2 }));
    expect(errors.some((e) => e.where === "version")).toBe(true);
  });

  it("rejects a top-level shape that is not an object with a questions array", () => {
    expect(errorsOf("[]")[0].where).toBe("(document)");
    expect(errorsOf('{"version":1}')[0].where).toBe("(document)");
  });

  // The whole point of a bulk path: an organizer pasting a 50-row file needs
  // every problem in one pass, not fifty round trips.
  it("collects EVERY error rather than stopping at the first", () => {
    const errors = errorsOf(
      JSON.stringify({
        version: 1,
        questions: [
          { id: "bad id!", prompt: " ", type: "trivia", choices: [], points: -1, order: 1.5, correct: [] },
        ],
      }),
    );
    const wheres = errors.map((e) => e.where);
    expect(wheres).toContain("questions[0].id");
    expect(wheres).toContain("questions[0].prompt");
    expect(wheres).toContain("questions[0].type");
    expect(wheres).toContain("questions[0].points");
    expect(wheres).toContain("questions[0].order");
    expect(wheres).toContain("questions[0].choices");
    expect(wheres).toContain("questions[0].correct");
  });

  it("rejects an unknown key on a question or on a choice", () => {
    expect(errorsOf(withQuestion({ flag: "ctfbox{nope}" }))[0].message).toMatch(/unknown key/i);
    const choiceErrors = errorsOf(withQuestion({ choices: [{ id: "a", label: "A", points: 5 }], correct: ["a"] }));
    expect(choiceErrors.some((e) => e.message.match(/unknown key/i))).toBe(true);
  });

  // A repeat would silently overwrite the earlier question AND inherit every
  // answer already banked against that id.
  it("rejects duplicate question ids within one file", () => {
    const errors = errorsOf(JSON.stringify({ version: 1, questions: [valid.questions[0], valid.questions[0]] }));
    expect(errors.some((e) => e.where === "questions[1].id" && /duplicate/i.test(e.message))).toBe(true);
  });

  // Bundle-only rule: the admin form generates choice ids, so only a
  // hand-written file can collide — and two choices sharing an id make the
  // question unanswerable in a way nothing downstream reports.
  it("rejects duplicate choice ids within one question", () => {
    const errors = errorsOf(
      withQuestion({
        choices: [
          { id: "a", label: "First" },
          { id: "a", label: "Second" },
        ],
        correct: ["a"],
      }),
    );
    expect(errors.some((e) => /duplicate choice id/i.test(e.message))).toBe(true);
  });

  it("rejects a correct id that is not one of the question's own choices", () => {
    const errors = errorsOf(withQuestion({ correct: ["z"] }));
    expect(errors.some((e) => e.where === "questions[0].correct[0]" && /choice ids/i.test(e.message))).toBe(true);
  });

  // Mirrors upsertQuestion: with more than one right answer, all-or-nothing
  // grading on a single-choice question could never be satisfied.
  it("rejects a single-choice question with more than one correct answer", () => {
    const errors = errorsOf(withQuestion({ correct: ["a", "b"] }));
    expect(errors.some((e) => /exactly one correct choice/i.test(e.message))).toBe(true);
  });

  // ...but canonicalization runs FIRST, exactly as upsertQuestion does it:
  // ["a","a"] is one correct answer, not two, and the store would accept it.
  it("accepts a single-choice question whose correct set repeats one id", () => {
    expect(parseBundle(withQuestion({ correct: ["a", "a"] })).ok).toBe(true);
  });

  // Not cosmetic: past the cap, JSON.stringify emits exponential notation
  // GRADE_SCRIPT's integer match cannot read, so the question would store
  // fine and then score 0 forever.
  it("enforces the same points bound the store does", () => {
    expect(parseBundle(withQuestion({ points: QUIZ_POINTS_MAX })).ok).toBe(true);
    expect(errorsOf(withQuestion({ points: QUIZ_POINTS_MAX + 1 }))[0].where).toBe("questions[0].points");
    expect(errorsOf(withQuestion({ points: 10.5 }))[0].where).toBe("questions[0].points");
  });

  // The prompt is the delete confirmation's required typed phrase, and
  // ConfirmModal reads an empty phrase as "no confirmation needed".
  it("rejects a whitespace-only prompt, not merely an empty one", () => {
    expect(errorsOf(withQuestion({ prompt: "   " }))[0].where).toBe("questions[0].prompt");
  });

  // A malformed `choices` array leaves nothing to check `correct` against;
  // reporting every correct id as unknown would bury the real error.
  it("does not report every correct id as unknown when choices itself is malformed", () => {
    const errors = errorsOf(withQuestion({ choices: "nope" }));
    expect(errors.some((e) => e.where === "questions[0].choices")).toBe(true);
    expect(errors.some((e) => e.where.startsWith("questions[0].correct"))).toBe(false);
  });

  it("accepts an empty bank — an export of a quiz with nothing authored yet", () => {
    expect(parseBundle(JSON.stringify({ version: 1, questions: [] }))).toEqual({
      ok: true,
      bundle: { version: 1, questions: [] },
    });
  });
});

describe("serializeBundle", () => {
  it("emits stable, human-editable JSON ending in a newline", () => {
    const text = serializeBundle(valid);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("\n  "); // indented, not minified
    expect(text).toBe(serializeBundle(valid));
  });
});

// The error list goes back to the admin client verbatim, and a bundle's
// values are arbitrary text: a correct choice id, a key name or a question id
// can carry an answer or a pasted secret. Every message names the indexed
// path and the rule, never the submitted value (#500 follow-up, the shape
// event-io.ts's `validateAttachmentFiles` set).
describe("quiz import errors never echo the submitted value (#500)", () => {
  const PLANTED = "FLAG{do-not-echo}";
  const PLANTED_ID = "planted-do-not-echo";
  const q0 = valid.questions[0];

  function expectNoEcho(errors: { where: string; message: string }[], where: string, secret = PLANTED): void {
    expect(errors.some((e) => e.where === where)).toBe(true);
    expect(JSON.stringify(errors)).not.toContain(secret);
  }

  it("a correct entry that is not a choice id names its position, not its value", () => {
    const errors = errorsOf(withQuestion({ type: "multi", correct: ["a", PLANTED] }));
    expect(errors).toContainEqual({ where: "questions[0].correct[1]", message: "must be one of this question's choice ids" });
    expectNoEcho(errors, "questions[0].correct[1]");
  });

  it("an invalid choice id names its position, not its value", () => {
    expectNoEcho(errorsOf(withQuestion({ choices: [{ id: PLANTED, label: "A" }], correct: ["a"] })), "questions[0].choices[0].id");
  });

  it("a duplicate choice id names the position, not the id", () => {
    const errors = errorsOf(
      withQuestion({ choices: [{ id: PLANTED_ID, label: "A" }, { id: PLANTED_ID, label: "B" }], correct: [PLANTED_ID] }),
    );
    expectNoEcho(errors, "questions[0].choices[1].id", PLANTED_ID);
  });

  it("unknown keys are counted, not named, on a question and on a choice", () => {
    expectNoEcho(errorsOf(withQuestion({ [PLANTED]: 1 })), "questions[0]");
    expectNoEcho(errorsOf(withQuestion({ choices: [{ id: "a", label: "A", [PLANTED]: 1 }] })), "questions[0].choices[0]");
  });

  it("an invalid question id, a bad type and a duplicate question id never echo", () => {
    expectNoEcho(errorsOf(withQuestion({ id: PLANTED })), "questions[0].id");
    expectNoEcho(errorsOf(withQuestion({ type: PLANTED })), "questions[0].type");
    const dup = { ...q0, id: PLANTED_ID };
    expectNoEcho(errorsOf(JSON.stringify({ version: 1, questions: [dup, dup] })), "questions[1].id", PLANTED_ID);
  });
});
