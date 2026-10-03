// `quiz` module's definition (#504 M10) — one entry of the
// REGISTRY literal that was ~1230 lines of lib/modules.ts, split out so that
// file is about the types and the accessors again and a copy edit to one
// module stops touching all four.
//
// `ModuleDef` comes back as a TYPE import — erased at compile time, so
// modules.ts -> this file -> modules.ts is not a runtime edge. The URLs the
// copy links into come from the dependency-free `module-urls.ts` leaf for
// the same reason: a value import from `@/lib/modules` would close the loop
// and throw at init.
import type { ModuleDef } from "@/lib/modules";
import { DOCS_URL } from "@/lib/module-urls";

export const QUIZ_DEF: ModuleDef = {
  id: "quiz",
  displayName: "Quiz",
  description: "Answer security questions for points.",
  nav: { href: "/quiz", label: "Quiz" },
  // The same shape as secure-development's, said in the quiz's own terms —
  // an event with no challenges cannot be told to patch one.
  emptyBoard: {
    line: "No answers banked yet. Every rank is unclaimed. Answer your first question and you’ll be the one everyone else is chasing.",
    cta: { href: "/quiz", label: "$ answer a question" },
  },
  // Deliberately plain and factual, and deliberately silent on AI: the
  // secure-development module invites an agent because patching WITH one is
  // the skill it teaches; on a graded question set the same invitation would
  // read as permission to cheat.
  //
  // Every claim below is checked against the implementation, because this is
  // contestant-facing copy and a landing page that promises something the
  // quiz doesn't do is worse than a plainer one that's true. Specifically:
  // there is NO topic constraint (upsertQuestion validates ids, choices and
  // points, nothing else), the UI never shows a remaining-attempts COUNT
  // (QuizQuestionView is unanswered | answered | cooldown | exhausted, and
  // quiz-board only says "No attempts remaining" once exhausted), the
  // attempt allowance itself is never rendered, and grading is exact-match
  // against a sorted key — all-or-nothing, including for `multi`.
  //
  // The copy DOES promise a leaderboard place, and that promise is true on
  // exactly the event this module exists for: `withModuleContributions`
  // takes the board's login set as the UNION of the scoring source's logins
  // and the ones holding module points, so a contestant whose only points
  // are quiz points gets a row CREATED for them rather than being invisible.
  // The promise was pulled once, while row creation was still an open gap;
  // it is back because the code changed. Check that function before pulling
  // it again.
  home: {
    tagline: "Quiz",
    intro: () =>
      "Answer security questions for points. Every question carries its own point value, is graded the moment you submit it, and counts toward your place on the leaderboard.",
    steps: () => [
      {
        title: "Sign in with GitHub",
        body: "Sign in to claim your row on the leaderboard. Your answers and points are recorded against your account, nothing is graded for a signed-out visitor, and signing in is what lets you leave and pick the set back up later.",
      },
      {
        title: "Work through the questions",
        body: "Take the set at your own pace. Each question shows what it is worth, and says so when it is on cooldown or out of attempts.",
      },
      {
        title: "Get scored on submit",
        body: "Your answer is graded immediately against the answer key. A correct answer scores its full points, a wrong one scores nothing, and either way there is no manual review.",
      },
    ],
    cta: { href: "/quiz", label: "Take the quiz" },
  },
  // The long-form guide, in the quiz's own terms. Same discipline as the
  // home block above: every claim is checked against quiz-store.ts and
  // components/quiz-board.tsx — grading is exact-match against a sorted key
  // (all-or-nothing, `multi` included), attempts can be capped and put on a
  // cooldown, neither the cap nor the remaining count is ever rendered, and
  // nothing is graded for a signed-out visitor. Deliberately silent on AI,
  // for the reason spelled out on `home`.
  guide: {
    lede: "New to the quiz? Here's everything you need to go from a GitHub sign-in to your first scored answer.",
    metaDescription:
      "Step-by-step guide to the quiz: sign in with GitHub, work through the questions, and get scored the moment you submit an answer.",
    loop: {
      kicker: "The loop",
      cycle: ["read the question", "pick your answer", "submit it", "it's scored on the spot"],
      note: "There are no flags to submit. Every question is graded automatically against a stored answer key the moment you answer it.",
    },
    steps: () => [
      {
        title: "Sign in with GitHub",
        body: "Use the sign-in button in the header. Your GitHub login is how the leaderboard and your profile track your progress, and nothing is graded for a signed-out visitor.",
      },
      {
        title: "Join a team, or play solo",
        body: "Scoring requires a team — answers don't count until you're on one, and the quiz page sends a teamless player to their profile first. From there: create a team, join one by code or invite link, or hit Play solo for a one-click team of one.",
      },
      {
        title: "Open the question set",
        body: "Every question the organizers have published is on the Quiz page, each one showing what it is worth. Take them in any order, at your own pace, and come back to the rest later.",
      },
      {
        title: "Answer the question",
        body: "Some questions have a single right answer; others are select-all-that-apply and only score if your whole selection matches. Read carefully before you submit: a question can be capped to a limited number of attempts, and can put you on a cooldown between tries.",
      },
      {
        title: "Get scored on submit",
        body: "Your answer is graded immediately against the answer key. A correct answer scores its full points, a wrong one scores nothing, and either way there is no manual grading and no waiting on an organizer.",
      },
    ],
    notes: [
      "Every question carries its own point value, and says what it is worth before you answer it.",
      "Organizers can cap how many times a question may be attempted and make you wait between tries. The question tells you when it is on cooldown and when you have run out of attempts.",
      "Points are credited to the GitHub account you signed in with. A question answered by several teammates counts once for the team, so a team's total can be less than its members' points added together.",
    ],
    scoring:
      "Every question is worth a fixed number of points, set by the organizers when they author it. Points are awarded the moment a correct answer is submitted, graded against a stored answer key, so nothing waits on manual review. Your live total is visible on your profile once you're signed in, and on the leaderboard alongside everyone else's.",
    cta: { href: "/quiz", label: "Take the quiz" },
  },
  rules: () => ({
    // No teams bullet: the identity rule is the platform's one sentence
    // now, and quiz had no module-specific nuance to add to it.
    teams: [],
    fairPlay: [
      "The published questions are the whole game. Do not attack the scoring pipeline, the leaderboard, or other contestants' accounts.",
      "Submit your own work. Don't publish answers for others to copy during the event.",
      "Automated or scripted answering to farm attempts will get your account rate-limited or disqualified.",
    ],
    conduct: [
      "Found a bug in a question, the scoring pipeline, or the site itself? Report it to an organizer instead of exploiting it for an unfair edge.",
    ],
    scoring: [
      "Each question is worth a fixed point value, set by the organizers. Points post the moment a correct answer is submitted.",
      "A question can be capped to a limited number of attempts and can hold you on a cooldown between tries. Once you have answered it correctly, it is done.",
    ],
  }),
  // The same questions a contestant actually asks, answered for a question
  // set instead of a patch workflow. Same discipline as the copy above:
  // every claim is checked against quiz-store.ts and quiz-board.tsx —
  // grading is exact-match against a sorted key, attempts can be capped and
  // put on a cooldown, the remaining count is never rendered, and nothing is
  // graded for a signed-out visitor. Deliberately silent on AI.
  faq: () => ({
    gettingStarted: [
      {
        q: "Do I need experience to compete?",
        a: "No. The question set spans a range of difficulty, and points scale with it. Start with whichever question looks approachable and work up.",
      },
    ],
    prep: [
      {
        q: "What do I need to bring?",
        a: "A GitHub account and something to read and click with. Everything runs in the browser, and nothing is installed or downloaded.",
      },
    ],
    playing: [
      {
        q: "How do I submit an answer?",
        a: [
          "Sign in, open the ",
          { route: { href: "/quiz", label: "Quiz" } },
          " page, pick your answer and submit it. Some questions have a single right answer; others are select-all-that-apply and only score if your whole selection matches. Grading is immediate, against a stored answer key, so there is nothing to wait for and nothing for an organizer to review.",
        ],
      },
      {
        q: "How is my progress tracked?",
        a: "Sign in with GitHub to claim your row on the live leaderboard and see how many questions you have answered, and what they were worth, on your profile. Points are credited to the account you signed in with, and nothing is graded for a signed-out visitor.",
      },
      {
        q: "Can I retry a question I got wrong?",
        a: "Sometimes. Organizers can cap how many times a question may be attempted and hold you on a cooldown between tries. The question says when it is on cooldown and when you have run out of attempts. Once you have answered one correctly, it is done.",
      },
      {
        q: "I answered correctly but didn't get points. What happened?",
        a: "Check that you were signed in when you submitted: nothing is graded for a signed-out visitor. On a select-all-that-apply question, a partly right selection scores nothing, so check whether you missed one of the correct options.",
      },
    ],
  }),
  terms: () => ({
    eligibility: [
      "You need a GitHub account. Your GitHub login is your identity for scoring, so answer from the account you sign in with. Points are credited to the account that submitted the answer and cannot be moved between accounts afterwards.",
      "Organizers and anyone who wrote or reviewed the questions may compete for fun but are not eligible for prizes.",
    ],
    scope: [
      "This event authorizes no testing of any system. The published questions are the whole game, and answering them is the whole of what you are invited to do here.",
      "Explicitly out of scope: the scoring pipeline, the leaderboard, this website, the CTF Discord, and other contestants' accounts or machines. Testing any of those is not authorized by this event, and nothing here should be read as permission to do so.",
      "Found a real security bug in this site or in the scoring pipeline? That is genuinely useful. Report it to an organizer rather than exploiting it. Doing so will not cost you anything.",
      "Automated or scripted answering, to farm attempts or to enumerate the answer key, will get your account rate-limited or disqualified.",
    ],
    submissions: [
      "You submit work by answering the published questions. Each answer is graded automatically against a stored answer key the moment you submit it.",
      "Submit your own work. Passing off another contestant's answers as yours is not allowed.",
      "Don't publish answers for others to copy while the event is running. Afterwards, write up whatever you like.",
    ],
    scoring: [
      "Each question is worth a fixed point value, set by the organizers, awarded automatically the moment a correct answer is submitted. Your best-ever result per question counts.",
      "A question can be capped to a limited number of attempts and can hold you on a cooldown between tries. Attempts are final: there is no refund and no reset.",
    ],
  }),
  routeCard: () => "Every question the organizers have published.",
  // Organizer-facing setup checklist (module contract §5.9). The one
  // `check` names `items`, which is what the quiz panel reports
  // (`quizInventory`) — there are no categories to count. Every claim is
  // checked against docs/operations.md's Quiz section and quiz-store.ts.
  setup: () => ({
    experience:
      "Contestants answer single- and multiple-choice questions on the quiz page. Each answer is graded on submit against the stored key — all-or-nothing on multi-select — with the attempt cap and retry cooldown you set here.",
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
        title: "Author at least one question",
        where: "panel",
        check: { count: "items", noun: "questions", one: "question" },
        body: "Add question, below, or paste a bundle under Bulk import / export. The question id is generated from the prompt when you save, and contestants see an empty board until one exists.",
      },
      {
        title: "Set the retry gate",
        where: "panel",
        body: "Max attempts (default 3; 0 is unlimited) and Retry after (default 1 minute; 0 is no cooldown), below. Both are global — there is no per-question override.",
      },
      {
        title: "Schedule scoring, if the event has a window",
        where: "panel",
        body: "Optional. Scoring opens and Scoring closes on the Event tab; outside the window an answer is refused as paused.",
      },
    ],
    midEvent: {
      safe: [
        "The retry gate. Lowering the cooldown lifts an active one immediately; a new cap applies on the next check.",
        "A typo in a prompt or a choice label. The id never changes, so banked answers stay attached.",
        "A question's points. Only future correct answers see the new price; earned points keep the old one.",
        "Adding questions, or reordering them. Contestants see the new order on their next page load.",
        "Importing a bundle. It creates or updates by id, never deletes, and never touches the retry gate.",
      ],
      unsafe: [
        [
          { strong: "Changing which choice is correct." },
          " It redefines the answer for everyone from that moment; points already banked stay on the board.",
        ],
        [
          { strong: "Deleting a question." },
          " It disappears from every board, but points already earned for it stay — only the master reset clears those, for everyone at once.",
        ],
      ],
    },
    docs: { href: `${DOCS_URL}operations#quiz`, label: "Quiz in the operations guide" },
  }),
};
