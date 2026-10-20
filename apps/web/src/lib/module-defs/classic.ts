// `classic` module's definition — one entry of the REGISTRY literal in
// lib/modules.ts, held in its own file so that file stays about the types
// and the accessors, and a copy edit to one module stops touching all four.
//
// `ModuleDef` comes back as a TYPE import — erased at compile time, so
// modules.ts -> this file -> modules.ts is not a runtime edge. The URLs the
// copy links into come from the dependency-free `module-urls.ts` leaf for
// the same reason: a value import from `@/lib/modules` would close the loop
// and throw at init.
import type { ModuleDef } from "@/lib/modules";
import { DOCS_URL } from "@/lib/module-urls";

export const CLASSIC_DEF: ModuleDef = {
  id: "classic",
  displayName: "Jeopardy",
  description: "Find the flag, submit the string, take the points.",
  nav: { href: "/flags", label: "Flags" },
  emptyBoard: {
    line: "No flags captured yet. Every rank is unclaimed. Capture your first flag and you’ll be the one everyone else is chasing.",
    cta: { href: "/flags", label: "$ capture a flag" },
  },
  // Deliberately plain and factual, and deliberately silent on AI, for the
  // same reason quiz's copy is: secure-development invites an agent because
  // patching WITH one is the skill it teaches; on a flag hunt the same
  // invitation reads as permission to cheat.
  //
  // Deliberately says "flag" where the other modules say "challenge" or
  // "question": "challenge" is on the secure-development term list this
  // whole module family gets checked against (see secure-dev-terms.ts) —
  // secure-development's own copy uses it constantly ("pick a challenge",
  // "every challenge is worth") — so a classic-only /how-to-play, /rules,
  // /faq or /terms that used it would trip that page's own leak test. "Flag"
  // is also just the word contestants actually use for one of these.
  //
  // Every claim below is checked against the implementation, same
  // discipline as quiz's: `flagComparisonForm` (classic-keys.ts) trims and
  // NFC-normalizes both sides, and lowercases them UNLESS the challenge is
  // marked case-sensitive (the board badges those) — so the
  // case-insensitivity claim must always carry that qualifier. Stating it
  // unconditionally shipped in v0.3.0 and contradicted the badge. There is NO attempt cap anywhere in classic-store.ts's
  // `evaluateGate`; it only ever refuses on paused/already-solved/cooldown,
  // never on a spent allowance, so never promise or imply one. There IS a
  // cooldown (`CLASSIC_COOLDOWN_SEC`, organizer-configurable in seconds via
  // `classicCooldownSec`). Every challenge carries a category and a point
  // value, and a solve count is shown (`challenge-board.tsx`'s tiles carry
  // the category heading and the "N pts" badge; `challenge-detail.tsx`'s
  // `ChallengeCard` carries the "N solve(s)" line on the challenge's own
  // page). Points are static — `SUBMIT_SCRIPT` reads the price off
  // the challenge hash at solve time and nothing anywhere lowers it as more
  // people solve. Nothing is graded for a signed-out visitor (`/flags`
  // renders a sign-in prompt instead of an input; `/api/classic/submit`
  // 401s with no session). Descriptions render through `markdown.ts`'s
  // small subset — bold, italics, inline code, lists, code blocks and
  // links — never raw HTML.
  home: {
    tagline: "Jeopardy",
    intro: () =>
      "Find each flag and submit it for points. Every flag carries its own point value, grading happens the instant you submit, and matching ignores leading or trailing whitespace and — unless a flag is marked case-sensitive on its card — capitalisation too.",
    steps: () => [
      {
        title: "Sign in with GitHub",
        body: "Sign in to claim your row on the leaderboard. Nothing is graded for a signed-out visitor, and signing in is what lets you leave and come back to the board later.",
      },
      {
        title: "Pick a flag and go find it",
        body: "Every flag is grouped by category and shows what it's worth and how many people have already solved it. Work in any order, at your own pace.",
      },
      {
        title: "Submit it and get scored",
        body: "Paste the flag into the box and submit. It's checked immediately: matching ignores case and leading or trailing whitespace, so a slightly different spelling still counts as long as the flag itself is right.",
      },
    ],
    cta: { href: "/flags", label: "Browse the flags" },
  },
  // The long-form guide. Same discipline as `home` above: every claim is
  // checked against classic-store.ts, challenge-board.tsx and
  // challenge-detail.tsx. No `example` or
  // `callout` block — classic has no worked example to walk (there's no
  // fixed method for finding a flag) and, like quiz, is deliberately silent
  // on AI.
  guide: {
    lede: "New to the board? Here's everything you need to go from a GitHub sign-in to your first solved flag.",
    metaDescription:
      "Step-by-step guide to the flag board: sign in with GitHub, work through the flags, and get scored the instant you submit a correct one.",
    loop: {
      kicker: "The loop",
      cycle: ["find the flag", "submit it", "it's scored on the spot"],
      note: "Every flag is checked immediately against the answer stored for it, the moment you submit.",
    },
    steps: () => [
      {
        title: "Sign in with GitHub",
        body: "Use the sign-in button in the header. Your GitHub login is how the leaderboard and your profile track your progress, and nothing is graded for a signed-out visitor.",
      },
      {
        title: "Join a team, or play solo",
        body: "Scoring requires a team — flags don't count until you're on one, and the board sends a teamless player to their profile first. From there: create a team, join one by code or invite link, or hit Play solo for a one-click team of one.",
      },
      {
        title: "Open the board",
        body: "Every flag the organizers have published is on the Flags page, grouped by category. Each one shows what it's worth and how many people have already solved it. Work in any order, at your own pace.",
      },
      {
        title: "Find the flag",
        body: "Read the description, then do whatever it takes to turn up the flag it's pointing at. There's no fixed method — some flags live in a file, others in a running app, others in the description itself.",
      },
      {
        title: "Submit it and get scored",
        body: "Paste the flag into the box and submit. It's checked instantly: matching ignores leading or trailing whitespace, and casing too — unless the flag is marked case-sensitive, which its card tells you. There's no cap on how many times you can try, though organizers can set a short cooldown between submissions on the same flag.",
      },
    ],
    notes: [
      "Every flag carries its own point value, and shows what it's worth before you submit it, plus how many people have already solved it.",
      "There's no cap on attempts. Organizers can set a short cooldown between submissions on the same flag, and the board tells you when it's still counting down.",
      "Points are credited to the GitHub account you signed in with. A flag found by several teammates counts once for the team, so a team's total can be less than its members' points added together.",
    ],
    scoring:
      "Every flag is worth a fixed number of points, set by whoever wrote it, and that value never changes as more people solve it. Points are awarded the instant a correct flag is submitted — leading or trailing whitespace is ignored, and casing is too unless the flag is marked case-sensitive — so nothing waits on manual review. Your live total is visible on your profile once you're signed in, and on the leaderboard alongside everyone else's.",
    cta: { href: "/flags", label: "Browse the flags" },
  },
  rules: () => ({
    // No teams bullet: the identity rule is the platform's one sentence
    // now, and classic had no module-specific nuance to add to it.
    teams: [],
    fairPlay: [
      "The published flags are the whole game. Do not attack the scoring pipeline, the leaderboard, or other contestants' accounts.",
      "Submit your own work. Don't publish flags or writeups for others to copy during the event.",
      "Automated or scripted submission to farm attempts will get your account rate-limited or disqualified.",
    ],
    conduct: [
      "Found a bug in a flag, the scoring pipeline, or the site itself? Report it to an organizer instead of exploiting it for an unfair edge.",
    ],
    scoring: [
      "Each flag is worth a fixed point value, set by whoever wrote it, and that value doesn't change as more people solve it.",
      "Points post the instant a correct flag is submitted. There's no cap on attempts, though a short cooldown between submissions on the same flag may apply.",
      "Revealing a hint deducts points from your total, and hint purchases are final.",
    ],
  }),
  faq: () => ({
    gettingStarted: [
      {
        q: "Do I need experience to compete?",
        a: "No. The flags span a range of difficulty, and points scale with it. Start with whichever one looks approachable and work up.",
      },
    ],
    prep: [
      {
        q: "What do I need to bring?",
        a: "A GitHub account and a laptop with whatever tools you're comfortable poking around with. There's no required software beyond what a flag itself calls for.",
      },
    ],
    playing: [
      {
        q: "How do I submit a flag?",
        a: [
          "Sign in, open the ",
          { route: { href: "/flags", label: "Flags" } },
          " page, and paste the flag into the box under the one you solved. Grading is instant and happens the moment you submit: there's nothing to wait for and nothing for an organizer to review.",
        ],
      },
      {
        q: "Does case or extra spacing matter?",
        a: "Leading and trailing whitespace never matters — it's trimmed before the comparison. Case usually doesn't either, but a flag can be marked case-sensitive, and its card tells you when it is; those are compared exactly as written.",
      },
      {
        q: "How is my progress tracked?",
        a: "Sign in with GitHub to claim your row on the live leaderboard and see how many flags you've solved, and what they were worth, on your profile. Points are credited to the account you signed in with, and nothing is graded for a signed-out visitor.",
      },
      {
        q: "Can I retry a flag I got wrong?",
        a: "Yes, as many times as you like — there's no cap on attempts. Organizers can put a short cooldown between submissions on the same flag; the board tells you when it's still counting down.",
      },
      {
        q: "I submitted the right flag but didn't get points. What happened?",
        a: "Check that you were signed in first: nothing is graded for a signed-out visitor. If you'd already solved that one before, resubmitting the same flag doesn't add more points — you already have them.",
      },
    ],
  }),
  terms: () => ({
    eligibility: [
      "You need a GitHub account. Your GitHub login is your identity for scoring, so submit every flag from the account you sign in with. Points are credited to that account and cannot be moved between accounts afterwards.",
      "Organizers and anyone who wrote or reviewed the flags may compete for fun but are not eligible for prizes.",
    ],
    scope: [
      "This event authorizes no testing of any system. The published flags are the whole of what you're invited to do here.",
      "Explicitly out of scope: the scoring pipeline, the leaderboard, this website, the CTF Discord, and other contestants' accounts or machines. Testing any of those is not authorized by this event, and nothing here should be read as permission to do so.",
      "Found a real security bug in this site or in the scoring pipeline? That is genuinely useful. Report it to an organizer rather than exploiting it. Doing so will not cost you anything.",
      "Automated or scripted submission, to farm attempts or to enumerate flags, will get your account rate-limited or disqualified.",
    ],
    submissions: [
      "You submit work by finding and entering the flag for each one you solve. Each submission is graded automatically against the stored answer the moment you submit it.",
      "Submit your own work. Passing off another contestant's flag as yours is not allowed.",
      "Don't publish flags or writeups for others to copy while the event is running. Afterwards, write up whatever you like.",
    ],
    scoring: [
      "Each flag is worth a fixed point value, set by whoever wrote it, awarded automatically the instant a correct submission is graded. That value doesn't change as more people solve it.",
      "There is no cap on attempts. A short cooldown between submissions on the same flag may apply, and organizers may adjust it during the event.",
      "Revealing a hint deducts points from your leaderboard total. Hint purchases are final. There is no refund.",
    ],
  }),
  routeCard: () => "Every flag the organizers have published.",
  // Organizer-facing setup checklist (module contract §5.9). Two checks —
  // `categories` first, then `items` — because a challenge cannot be
  // authored until a category exists (the Add challenge button is disabled
  // until then), and both are what the classic panel reports
  // (`classicInventory`). Claims checked against docs/operations.md's
  // Classic section and classic-store.ts.
  setup: () => ({
    experience:
      "Contestants see a board of flag challenges grouped by category on the flags page, submit a flag per challenge and are graded instantly. Matching trims whitespace and ignores case unless you mark a challenge case-sensitive; a per-challenge cooldown in seconds limits how fast they can retry, and a challenge may carry a paid hint.",
    steps: [
      {
        title: "Enable the module",
        where: "panel",
        body: [
          "Switch it on from the Event tab — modules are enabled at runtime (issue #386), from ",
          { code: "/admin" },
          " alone. There is no config file and nothing is baked into the image.",
        ],
      },
      {
        title: "Add at least one category",
        where: "panel",
        check: { count: "categories", noun: "categories", one: "category" },
        body: "Every challenge files under a category, so Add challenge stays disabled until one exists. Categories can be reordered; one can be removed only while no challenge uses it.",
      },
      {
        title: "Author at least one challenge",
        where: "panel",
        check: { count: "items", noun: "challenges", one: "challenge" },
        body: "Title, category, a Markdown description, points and the flag — or paste a bundle under Bulk import / export. The id is generated from the title when you save. Flags are stored in plaintext and visible to anyone with access to this panel.",
      },
      {
        title: "Set the submission cooldown",
        where: "panel",
        body: "Seconds a contestant must wait between attempts on the same challenge (default 5; 0 is none). Seconds — every other cooldown on this panel is in minutes.",
      },
      {
        title: "Set the hint policy, if any challenge carries a hint",
        where: "panel",
        body: "The hint text is authored per challenge below; its price and who may buy it are the Hints section on the Event tab, shared with the other modules.",
      },
    ],
    midEvent: {
      safe: [
        "The submission cooldown. It applies on the next check.",
        "A typo in a title or description. The id never changes, so banked solves stay attached.",
        "A challenge's points. Only future solves see the new price.",
        "Adding challenges, or reordering them. Contestants see the new order on their next page load.",
        "A challenge's hint text. Saving it empty removes the hint.",
        "Importing a bundle. It creates or updates by id, adds any categories it names, and never deletes.",
      ],
      unsafe: [
        [
          { strong: "Editing a flag, or the case-sensitive toggle." },
          " It redefines what counts as solved from that moment; solves already banked stay.",
        ],
        [
          { strong: "Deleting a challenge." },
          " It disappears from the board, but points already earned for it stay — only the master reset clears those, for everyone at once.",
        ],
        "Removing a category that challenges still use. The panel refuses and names how many are blocking it.",
      ],
    },
    docs: { href: `${DOCS_URL}operations#jeopardy`, label: "Jeopardy in the operations guide" },
  }),
};
