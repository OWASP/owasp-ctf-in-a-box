// The secure-development vocabulary, enumerated once and asserted ABSENT by
// every "this event doesn't run that module" page suite.
//
// This list is the load-bearing part of those tests, and it has to be
// deliberately exhaustive rather than illustrative. The landing page's
// equivalent check originally covered "pull request", "fork" and
// "Browse targets" but NOT "patched" — and "patched" was the one string that
// had actually leaked (a progress card promising a "patched and non-patched
// count per app" on an event with nothing to patch). The hole sat exactly
// where the bug was.
//
// The rule, learned the hard way three times on this work: when a term
// threatens a false positive, NARROW the match — never drop the term. A
// dropped term is a silent hole in the shape of the thing it named. "target"
// was dropped once here on the grounds that `target="_blank"` made it
// unusable, and a mutation putting *"Browse the targets, then point your AI
// agent at a target"* into the platform frame sailed through the whole
// suite. It is a bounded pattern now, not an omission.
//
// Narrowing in force:
//   - "repo" as a bare substring matches "Report it to an organizer" — it is a
//     word-boundary pattern instead, which does not fire inside "Report".
//   - "target" matches every `target="_blank"` attribute — a word-boundary
//     pattern with a `(?!=)` lookahead keeps the prose and drops the
//     attribute. It also matches /code-of-conduct's "you do not need to be
//     the target to report something", where the word means the person a
//     behaviour is aimed at — a `be the` lookbehind drops that sense and
//     keeps every other use. The alternative was rewriting the sentence,
//     which is exactly what this file's own rule forbids: it is platform
//     copy, it renders on secure-development events too, and the replacement
//     ("to have been harmed yourself") also narrowed WHO is told to report.
//   - "commit" matches the platform's own "what taking part commits you to"
//     on /terms and /code-of-conduct — a `(?!\s+you)` lookahead keeps
//     "the commit message" and drops the obligation sense.
//   - "flag" matches the quiz's own "There are no flags to submit" — only the
//     secure-development phrase "flag hunting" is listed.
//   - "PR" and "CI" match inside ordinary words, so they are word-boundary
//     regexes too.
//
// LIVE vs LATENT. Every term, and every LIVE pattern, is proven live by
// secure-dev-terms.test.ts: it renders the pages that ARE supposed to carry
// this vocabulary and asserts each one matches something. A term that rots
// into decoration — as "repository" and the unescaped "repo's" both silently
// had — fails there.
//
// A handful of terms name the workflow just as squarely but do not happen to
// appear in today's shipped copy: merge, diff, rebase, CVE. Leaving them out
// left a hole exactly the shape of the words nobody had written yet — a
// reviewer's mutation, *"Merge your diff for the CVE into WebGoat, then clone
// the repository"*, dropped into unconditional copy on /rules, /how-to-play
// and /profile and left all three quiz-only suites green. They are listed as
// LATENT and proven against SPECIMENS instead: the check is the same in
// substance (the pattern must actually fire on the copy it names) without
// pretending the shipped pages contain a word they do not. Absence is
// asserted against all of them alike — `findSecureDevLeaks` does not
// distinguish.

/** Rendered markup, entity-decoded and lowercased: what the substring terms
 *  below are matched against. Decoding matters — React escapes apostrophes,
 *  so "repo's" only ever appears in the HTML as `repo&#x27;s`, and a raw
 *  substring check for it can never fire. */
export function normalizeHtml(html: string): string {
  return html
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .toLowerCase();
}

/** Matched as substrings against `normalizeHtml(markup)`. */
export const SECURE_DEV_TERMS = [
  "pull request",
  "fork",
  "patch",
  "regression",
  "vulnerab",
  "secure development",
  "flag hunting",
  "sql injection",
  "gh repo",
  "repo's",
  "git commit",
  "git checkout",
  "branch",
  "github action",
  "scorer",
  // "challenge" is NOT exclusive to secure-development's vocabulary — the
  // classic module's own store type is `Challenge` (classic-store.ts), and
  // its admin authoring form says "Challenge id". /admin and /leaderboard
  // are surfaces where classic legitimately renders that word by design
  // (the leaderboard empty-board line and CTA for classic both say
  // "flag", not "challenge" — see modules.ts — but the admin panel's own
  // labels for the classic module do say "challenge"). A leak test written
  // against either of those two surfaces for a classic-only event will see
  // this term false-positive there; that is a reason to keep the check off
  // those surfaces, per this file's header rule, never a reason to drop the
  // term.
  "challenge",
  // "hint" was here, and is deliberately gone (#249). It stopped being
  // secure-development vocabulary when classic (#209/#210) and ai began
  // selling hints through the same gate and the same four settings — so a
  // classic-only or ai-only page naming one is describing ITS OWN game, and
  // is now REQUIRED to: the price of a hint reached those contestants only
  // from the reveal button. Unlike "challenge" just above, this cannot be
  // handled by scoping which surfaces are checked, because the term now
  // belongs in the contestant copy of the very pages these suites render.
  //
  // What that costs: the quiz-only variants no longer catch a stray "hint",
  // and quiz has no hints by design. That guarantee moved to the registry
  // itself — see "hint cost is stated wherever hints are sold" in
  // lib/__tests__/modules.test.ts, which asserts it per module rather than
  // per page.
  "top 10",
  "secure agent playbook",
  "please use ai",
  // The fork-org path (`OWASP-CTF/juice-shop`) was a bare substring here
  // until the kit itself was renamed owasp-ctf and the landing page's docs
  // link became `dcotelo.github.io/owasp-ctf/`, which the substring could not
  // tell from the org. It is the `(?<!\/)` pattern in the LIVE list instead.
  // The kit has since moved to `owasp.github.io/owasp-ctf-in-a-box/`, so that
  // particular collision is gone; the lookbehind still earns its place on
  // `github.com/OWASP-CTF/<target>` links.
  "/challenges",
  // Every target this kit ships. A page that names one is describing
  // secure-development's game whatever else it says, and the app names were
  // the widest hole in this list: a quiz-only page could talk about WebGoat
  // and DVWA at length without tripping a single assertion. Matched on the
  // distinctive fragment so both the display name and the app id are caught
  // ("Security Shepherd" and "securityshepherd" alike).
  "juice",
  "webgoat",
  "dvwa",
  "shepherd",
  "vulnerableapp",
  "vampi",
];

/** Terms that need word boundaries: a bare substring check fires on ordinary
 *  words ("PR" inside a word, "repo" inside "Report", "diff" inside
 *  "difficulty") or on markup (`target="_blank"` on every external link).
 *  Matched against the RAW markup, case-insensitively unless the term is an
 *  acronym whose case carries the meaning.
 *
 *  LIVE: proven against the shipped secure-development render. */
export const SECURE_DEV_LIVE_PATTERNS = [
  /\bPRs?\b/,
  /\bCI\b/,
  // Prose about targets — "browse the targets", "point it at a target" —
  // without the `target="..."` attribute that made this term look unusable,
  // and without the code of conduct's "be the target" (the person a behaviour
  // is aimed at). Both exclusions are bounded: everything from "the target's
  // repo" to "3 challenge targets" still fires.
  /(?<!\bbe the )\btargets?\b(?!=)/i,
  // The bare noun, which "gh repo"/"repo's" above only catch in two fixed
  // phrasings. The word boundary is what keeps it off "Report it to an
  // organizer" — the false positive that got the whole term dropped once.
  /\brepos?\b/i,
  /\brepositor(y|ies)\b/i,
  // "commits you to" is the platform's own phrasing on /terms and
  // /code-of-conduct, and is the obligation sense, not the git one.
  /\bcommits?\b(?!\s+you\b)/i,
  /\bclon(e|ed|es|ing)\b/i,
  // The GitHub org the targets are forked into, as it appears in the guide's
  // shell commands and prose: `gh repo fork OWASP-CTF/juice-shop`, "the base
  // repo is OWASP-CTF/juice-shop". The lookbehind drops the one shape that is
  // a URL path segment — preceded by `/` — and keeps the org shape, which
  // never is. It was added because the kit's own name was the same slug and
  // its two links rendered on every event; the move to
  // `OWASP/owasp-ctf-in-a-box` retired that case, and what the lookbehind
  // still covers is a link into the fork org itself. Bounded, and the same
  // boundary as before: a bare `https://github.com/OWASP-CTF/` link slips
  // past this pattern, but every target name is its own term, so the fork of
  // any shipped target is still caught by that.
  /(?<!\/)owasp-ctf\//i,
];

/** LATENT: the same domain, in words today's copy does not use. Proven
 *  against `SECURE_DEV_SPECIMENS` rather than the render — see the header
 *  note. Absence is asserted against these exactly as against the live ones. */
export const SECURE_DEV_LATENT_PATTERNS = [
  /\bmerg(e|ed|es|ing)\b/i,
  /\bdiffs?\b/i,
  /\brebas(e|ed|es|ing)\b/i,
  /\bCVEs?\b/i,
];

/** Everything a leak check asserts the absence of. Consumers use this one;
 *  the split above exists only so the self-verifying test knows which half to
 *  prove against which corpus. */
export const SECURE_DEV_PATTERNS = [
  ...SECURE_DEV_LIVE_PATTERNS,
  ...SECURE_DEV_LATENT_PATTERNS,
];

/** Copy that a page running secure-development could plausibly ship, used to
 *  prove the latent patterns fire. The first is verbatim the mutation a
 *  reviewer dropped into unconditional copy on /rules, /how-to-play and
 *  /profile, which the pre-extension list let through all three quiz-only
 *  suites untouched. */
export const SECURE_DEV_SPECIMENS = [
  "Merge your diff for the CVE into WebGoat, then clone the repository.",
  "Rebase your branch onto main, then push it again to re-score the run.",
];

/** Every secure-development term the given markup leaks, as a list so a
 *  failure names all of them at once instead of one per run. */
export function findSecureDevLeaks(html: string): string[] {
  const normalized = normalizeHtml(html);
  return [
    ...SECURE_DEV_TERMS.filter((term) => normalized.includes(term)),
    ...SECURE_DEV_PATTERNS.filter((pattern) => pattern.test(html)).map(String),
  ];
}
