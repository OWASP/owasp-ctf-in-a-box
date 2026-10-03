// `ai` module's definition (#504 M10) — one entry of the
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

export const AI_DEF: ModuleDef = {
  id: "ai",
  displayName: "AI",
  description: "Prompt-injection and guardrail challenges hosted outside the box, scored inside it.",
  // /ai exists now (the pages PR), so the module gets its nav entry — and
  // the 404's route directory.
  nav: { href: "/ai", label: "AI" },
  emptyBoard: {
    line: "No challenges solved yet. Every rank is unclaimed. Solve your first AI challenge and you’ll be the one everyone else is chasing.",
    cta: { href: "/ai", label: "$ open a challenge" },
  },
  // Deliberately plain and factual, same discipline as quiz's and classic's
  // copy: every claim below is checked against the implementation — this
  // block predates the admin panel and hints shipping, so it stuck to what
  // was true at the time rather than promising either. Both have since
  // shipped (admin-ai-controls.tsx; hint-store.ts's ai target) and neither
  // needed this copy to change, since it never claimed they didn't exist.
  // Specifically checked against ai-store.ts, ai-token.ts and
  // ai-launch.ts, and the /api/ai routes:
  //
  //   - Each challenge is hosted on an EXTERNAL site (`AiChallenge.urlTemplate`).
  //     Opening it from `/ai/[id]` mints a fresh, PERSONAL launch token
  //     (`mintLaunchUrl`/`buildLaunchClaims`) naming the signed-in login in
  //     `sub` — nothing else on this box mints one.
  //   - `mode` is "event", "flag" or "both" (`AI_MODES`). An event-mode
  //     challenge reports its own solve back automatically, asserted by the
  //     external side against `/api/ai/event` (HMAC-signed, keyed by a
  //     per-challenge key the box alone issues); a flag/both challenge also
  //     takes a typed flag on the challenge page, graded instantly by
  //     `submitAiFlag` against a stored answer.
  //   - The launch token IS the identity carried onto the external site
  //     (`AiTokenClaims.sub`), and `/api/ai/submit` and `/api/ai/event` both
  //     act on `claims.sub` alone — cookie-blind, by design. Whoever holds a
  //     copy of the link plays and is rate-limited/cooled-down AS that login;
  //     there is no second check that the browser holding it is the one it
  //     was minted for. So: it is personal, sharing it lets someone else
  //     submit as you or spend your cooldown, and every point it earns still
  //     lands on your account regardless of who used it.
  //   - Solve timestamps are stamped by `runAward` by the box's own
  //     `new Date()` at award time — never a time the external side reports
  //     — so the box's clock decides when a solve happened, not the
  //     challenge's.
  //   - There is NO attempt cap in `evaluateGate`/`AWARD_SCRIPT`: it refuses
  //     only on paused/already-solved/cooldown, same as classic. There IS a
  //     cooldown (`AI_COOLDOWN_SEC`), applied to the GRADED path only — a
  //     signed event has no wrong answer to rate-limit (`awardAiEvent` passes
  //     cooldown 0). Hints and the admin control panel have since shipped
  //     (`admin-ai-controls.tsx`, `hint-store.ts`'s `ai` target) — nothing
  //     in this copy claims otherwise, so nothing here needed to change for
  //     that; this note just retires the "not yet" framing now that both are
  //     real.
  home: {
    tagline: "AI",
    intro: () =>
      "Each challenge is hosted on an external site. Open it from its page for a personal launch link, play it there, and a correct solve reports back to the leaderboard on its own — or, where a challenge also takes one, grade yourself by typing the flag on the page.",
    steps: () => [
      {
        title: "Sign in with GitHub",
        body: "Sign in to claim your row on the leaderboard. Nothing is graded for a signed-out visitor, and signing in is what lets you leave and come back to a challenge later.",
      },
      {
        title: "Open a challenge and get your link",
        body: "Every challenge is grouped by category and shows what it's worth. Opening one from its page mints you a personal launch link into the external site — that link is how it knows who you are, so it's yours alone.",
      },
      {
        title: "Play it, submit if it asks",
        body: "Work the challenge on the external site. A solve reports back to the leaderboard on its own, or, where the challenge also takes one, paste the flag into the box on its page and it's graded the instant you submit.",
      },
    ],
    cta: { href: "/ai", label: "Browse the challenges" },
  },
  guide: {
    lede: "New to the board? Here's everything you need to go from a GitHub sign-in to your first solved challenge.",
    metaDescription:
      "Step-by-step guide to the AI module: sign in with GitHub, open a challenge for your personal link, and get scored the moment it reports back or you submit a flag.",
    loop: {
      kicker: "The loop",
      cycle: ["open the challenge", "play it externally", "it reports back, or you submit the flag"],
      note: "Every solve is checked the moment it lands — automatically when the external site reports it, or instantly against the stored flag when you submit one yourself. Either way, the box's own clock decides when it happened.",
    },
    steps: () => [
      {
        title: "Sign in with GitHub",
        body: "Use the sign-in button in the header. Your GitHub login is how the leaderboard and your profile track your progress, and it's also the identity your personal launch link carries onto the external site.",
      },
      {
        title: "Join a team, or play solo",
        body: "Scoring requires a team — a challenge doesn't count until you're on one, and the board sends a teamless player to their profile first. From there: create a team, join one by code or invite link, or hit Play solo for a one-click team of one.",
      },
      {
        title: "Open the board",
        body: "Every challenge the organizers have published is on the AI page, grouped by category. Each one shows what it's worth and how many people have already solved it. Work in any order, at your own pace.",
      },
      {
        title: "Open a challenge for your personal link",
        body: "Opening a challenge from its page mints a launch link that signs you straight into the external site as you. It's yours alone — anyone who has it plays under your name, cooldown included — and if it ever goes stale, reopening the page mints a fresh one.",
      },
      {
        title: "Play it, and let it report back or submit the flag",
        body: "Play the challenge on the external site. Most report a solve back on their own the instant you clear them; where a challenge also takes a typed flag, paste it into the box on its page and it's graded immediately. Either way, the box's own clock decides when you solved it.",
      },
    ],
    notes: [
      "Every challenge carries its own point value, and shows what it's worth before you open it, plus how many people have already solved it.",
      "Your launch link is personal. Reopening the challenge page mints a fresh one, but don't hand yours to someone else: whatever they do with it happens under your name, cooldown included, and every point it earns still lands on your account.",
      "Points are credited to the GitHub account your launch link named. A challenge solved by several teammates counts once for the team, so a team's total can be less than its members' points added together.",
    ],
    scoring:
      "Every challenge is worth a fixed number of points, set by whoever wrote it. Points are awarded the moment your solve is recorded — automatically when the external site reports it, or instantly when a typed flag matches — so nothing waits on manual review. Your live total is visible on your profile once you're signed in, and on the leaderboard alongside everyone else's.",
    cta: { href: "/ai", label: "Browse the challenges" },
  },
  rules: () => ({
    // No teams bullet: the identity rule is the platform's one sentence
    // now, and the link-sharing nuance belongs to fair play, not team
    // crediting.
    teams: [],
    fairPlay: [
      "The published challenges are the whole game. Do not attack the scoring pipeline, the leaderboard, or other contestants' accounts.",
      "Your launch link is personal. Do not share it: anyone holding it can play or submit as you, cooldown included, and every point it earns still lands on your account regardless of who used it.",
      "Automated or scripted play to farm attempts will get your account rate-limited or disqualified.",
    ],
    conduct: [
      "Found a bug in a challenge, the scoring pipeline, or the site itself? Report it to an organizer instead of exploiting it for an unfair edge.",
    ],
    scoring: [
      "Each challenge is worth a fixed point value, set by whoever wrote it. Points post the moment your solve is recorded, whether the external site reported it or you submitted a matching flag.",
      "The box's own clock decides when a solve happened, not the external site's.",
      "Revealing a hint deducts points from your total, and hint purchases are final.",
    ],
  }),
  faq: () => ({
    gettingStarted: [
      {
        q: "Do I need experience to compete?",
        a: "No. The challenges span a range of difficulty, and points scale with it. Start with whichever one looks approachable and work up.",
      },
      {
        q: "Do I need my own AI account?",
        a: "Depends on the event's challenges — some external sites ask you to sign in with something of your own, others don't. Check the challenge page, or ask an organizer if a specific one isn't clear.",
      },
    ],
    prep: [
      {
        q: "What do I need to bring?",
        a: "A GitHub account and a laptop. Everything else runs on the external site each challenge links to.",
      },
    ],
    playing: [
      {
        q: "How do I play a challenge?",
        a: [
          "Sign in, open the ",
          { route: { href: "/ai", label: "AI" } },
          " page, and open the one you want. That mints you a personal launch link into the external site — follow it and play there. A solve reports back on its own, or, where the challenge also takes one, paste the flag into the box on its page.",
        ],
      },
      {
        q: "How is my progress tracked?",
        a: "Sign in with GitHub to claim your row on the live leaderboard and see how many challenges you've solved, and what they were worth, on your profile. Points are credited to the account your launch link named, and nothing is graded for a signed-out visitor.",
      },
      {
        q: "I solved it on the site but see no points. What happened?",
        a: "Reopen the challenge page for a fresh link and check the leaderboard — sometimes a solve just hasn't landed yet. Still nothing after that? Ask an organizer.",
      },
      {
        q: "Can I retry a challenge I haven't solved?",
        a: "Yes. There's no cap on attempts, though a short, fixed cooldown sits between wrong tries on the same challenge; reopening the challenge page always gets you a fresh launch link.",
      },
    ],
  }),
  terms: () => ({
    eligibility: [
      "You need a GitHub account. Your GitHub login is your identity for scoring — it's also what your personal launch link carries onto the external site — and points are credited to that account and cannot be moved between accounts afterwards.",
      "Organizers and anyone who wrote or reviewed the challenges may compete for fun but are not eligible for prizes.",
    ],
    scope: [
      "This event authorizes no testing of any system. The published challenges are the whole of what you're invited to do here, on whichever external site each one names.",
      "Explicitly out of scope: the scoring pipeline, the leaderboard, this website, the CTF Discord, and other contestants' accounts or launch links. Testing any of those is not authorized by this event, and nothing here should be read as permission to do so.",
      "Found a real security bug in this site or in the scoring pipeline? That is genuinely useful. Report it to an organizer rather than exploiting it. Doing so will not cost you anything.",
      "Automated or scripted play, to farm attempts or to enumerate flags, will get your account rate-limited or disqualified.",
    ],
    submissions: [
      "Playing an external challenge sends your GitHub login and your progress on this module to that challenge's operator — that is what your personal launch link carries, and it's how the site knows you and can report your solve back.",
      "Submit your own work. Passing off another contestant's solve as yours is not allowed, and neither is playing under someone else's launch link.",
      "Don't publish flags or writeups for others to copy while the event is running. Afterwards, write up whatever you like.",
    ],
    scoring: [
      "Each challenge is worth a fixed point value, set by whoever wrote it, awarded automatically when your solve is recorded — whether the external site reported it or you submitted a matching flag. Your best-ever result per challenge counts.",
      "There is no cap on attempts. A short, fixed cooldown applies between wrong submissions on the same challenge.",
      "Revealing a hint deducts points from your leaderboard total. Hint purchases are final. There is no refund.",
    ],
  }),
  routeCard: () => "Every AI challenge the organizers have published.",
  // Organizer-facing setup checklist (module contract §5.9). Same two
  // checks as classic (`categories`, then `items`), for the same reason,
  // and reported the same way (`aiInventory`). The external site is a real
  // dependency the panel cannot see, so that step is a plain item. Claims
  // checked against docs/operations.md's AI section and docs/ai-module.md.
  setup: () => ({
    experience:
      "Contestants pick a challenge on the AI board and get a personal launch link into an external challenge site. A solve comes back either as a signed event from that site or as a flag typed back into the box, depending on the challenge's solve mode.",
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
        title: "Stand up the external challenge site against the integration contract",
        where: "outside",
        body: [
          "Four things on their side: accept the token your launch URL carries at ",
          { code: "{token}" },
          "; verify it with the public key at ",
          { code: "/api/ai/launch-key" },
          " (hard-coded Ed25519, audience pinned to the challenge id); for an event-mode challenge post the solve back to ",
          { code: "/api/ai/event" },
          " signed with that challenge's own key over ",
          { code: '"<timestamp>.<raw body>"' },
          " within ±300s; and expect one award per token — a replayed ",
          { code: "jti" },
          " answers 409. The panel's Wiring the external site drawer says the same beside the values you paste, and the full contract, opening with an animated diagram of the handshake, is ",
          { link: { href: `${DOCS_URL}ai-module`, label: "docs/ai-module.md" } },
          ".",
        ],
      },
      {
        title: "Add at least one category",
        where: "panel",
        check: { count: "categories", noun: "categories", one: "category" },
        body: "Every challenge files under a category, so Add challenge stays disabled until one exists.",
      },
      {
        title: "Author at least one challenge",
        where: "panel",
        check: { count: "items", noun: "challenges", one: "challenge" },
        body: [
          "A solve mode (graded by flag, external event only, or either), an ",
          { code: "https" },
          " launch URL containing ",
          { code: "{token}" },
          ", a flag unless the mode is event-only, points, and an optional paid hint. The id is generated from the title when you save; the hint's price and gating are the Hints section on the Event tab.",
        ],
      },
      {
        title: "Hand the external site its endpoints and signing key",
        where: "panel",
        body: "Each challenge row below shows the Submit, Event and State URLs with copy buttons, and the challenge's own signing key, masked until you reveal it.",
      },
      {
        title: "Send test",
        where: "panel",
        body: "The dry run signs a demo event with the challenge's real key and relays the box's verdict; Would award is the good answer. It runs as you, so you need to be on a team, or it answers no-team.",
      },
      {
        title: "Set the submission cooldown",
        where: "panel",
        body: "Seconds between graded flag attempts on the same challenge (default 5; 0 is none). Signed events from the external site are never throttled by it.",
      },
    ],
    midEvent: {
      safe: [
        "The submission cooldown. It applies on the next check.",
        "A typo in a title or description, or a challenge's points. The id never changes; only future solves see a new price.",
        "A challenge's hint text. Saving it empty removes the hint.",
        "Adding challenges.",
      ],
      unsafe: [
        [
          { strong: "Rotate." },
          " The external system stops posting until you redeploy it with the new key — there is no grace window.",
        ],
        [{ strong: "Deleting a challenge." }, " It revokes that challenge's signing key at once; points already earned for it stay."],
        [
          { strong: "Switching a challenge to external event only." },
          " The box deletes its stored flag, and the in-box flag form disappears for contestants.",
        ],
        [
          { strong: "A master reset." },
          " It rotates the module-wide launch keypair: every issued launch link stops verifying and the external site must re-fetch the public key.",
        ],
      ],
    },
    docs: { href: `${DOCS_URL}operations#ai`, label: "AI in the operations guide" },
  }),
};
