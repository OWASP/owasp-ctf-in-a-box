// `secure-development` module's definition — one entry of the REGISTRY
// literal in lib/modules.ts, held in its own file so that file stays about
// the types and the accessors, and a copy edit to one module stops touching
// all four.
//
// `ModuleDef` comes back as a TYPE import — erased at compile time, so
// modules.ts -> this file -> modules.ts is not a runtime edge. The URLs the
// copy links into come from the dependency-free `module-urls.ts` leaf for
// the same reason: a value import from `@/lib/modules` would close the loop
// and throw at init.
import type { ModuleDef } from "@/lib/modules";
import { DOCS_URL, SCORING_BRANCH, SECURE_AGENT_PLAYBOOK_URL } from "@/lib/module-urls";

export const SECURE_DEVELOPMENT_DEF: ModuleDef = {
  id: "secure-development",
  displayName: "Secure Development",
  description: "Find the vulnerability, patch it for real, ship the fix as a PR.",
  nav: { href: "/challenges", label: "Challenges" },
  // Moved VERBATIM off the leaderboard's EmptyBoard, curly apostrophe
  // included (the JSX spelled it `&rsquo;`, which React emits as U+2019, so
  // the rendered bytes are unchanged).
  emptyBoard: {
    line: "No flags captured yet. Every rank is unclaimed. Patch your first challenge and you’ll be the one everyone else is chasing.",
    cta: { href: "/challenges", label: "$ pick a challenge" },
  },
  // Moved VERBATIM off app/page.tsx, curly apostrophes included: the JSX
  // spelled them `&rsquo;`, which React emits as a literal U+2019, so the
  // rendered bytes are unchanged. Retyping them as ASCII "'" would be a
  // silent copy change no test would notice.
  home: {
    tagline: "Secure Development",
    intro: (ctx) =>
      // "training apps", not "OWASP training apps": DVWA and VAmPI are
      // community projects, and the hero must not claim otherwise (the
      // targets section makes the same correction).
      `Break real vulnerabilities in ${ctx.appCount} deliberately vulnerable training ${ctx.appCount === 1 ? "app" : "apps"}, patch them for real, and ship the fix as a GitHub pull request. CI validates your patch and scores it automatically. Practice the full secure development lifecycle, not just flag-hunting.`,
    steps: (ctx) => [
      {
        title: "Pick a target",
        body: `Choose from ${ctx.appCount} real, deliberately vulnerable ${ctx.appCount === 1 ? "app" : "apps"}: ${ctx.appList}.`,
      },
      {
        title: "Find the vulnerability",
        body: "Work through the OWASP Top 10 (Web and API) to identify a real flaw in the target's source. Please use AI. Point an agent at the codebase. That's the workflow this event is built to teach.",
      },
      {
        title: "Patch it and open a PR",
        body: `Fix the vulnerability in your fork, then submit a pull request against the repo's ${SCORING_BRANCH} branch. This is secure development, not flag hunting.`,
      },
      {
        title: "Get scored automatically",
        body: "A GitHub Action runs that challenge's regression test against your patched app. A passing test scores points immediately, no manual grading.",
      },
    ],
    cta: { href: "/challenges", label: "Browse targets" },
    // "Please use AI" belongs to THIS module, not to the platform frame: it
    // says writing the patch with an agent is the skill the event exists to
    // build, which in a quiz-only event would read as an invitation to cheat.
    extra: {
      kicker: "Bring your agent",
      heading: "Please use AI",
      body: "This isn’t tolerated, it’s the point. Reviewing code, finding the flaw, and writing the patch with an AI agent is the skill this event exists to build. Bring whatever you already use (Claude Code, Copilot, Cursor, your own harness) and let it read the target.",
    },
  },
  // Moved VERBATIM off app/(site)/how-to-play/page.tsx. Same rule as `home`
  // above: where the JSX spelled a character as `&rsquo;`/`&apos;`, this
  // holds the character React actually emitted (U+2019 and ASCII ' — they
  // are NOT interchangeable), so the rendered bytes are unchanged.
  guide: {
    lede: "New to the competition? Here's everything you need to go from a GitHub sign-in to your first patched challenge.",
    metaDescription:
      "Step-by-step guide to OWASP Secure Development: fork a target, patch a real vulnerability, open a PR, and get scored automatically.",
    loop: {
      kicker: "The loop",
      cycle: ["find the flaw", "patch it", "open a PR", "CI scores it"],
      note: "There are no flags to submit. Every challenge is scored by an automated regression test that only passes once the vulnerability is actually fixed.",
    },
    // Sits above the steps because it changes how you do step 4, and
    // contestants who skim only the numbered list still see it.
    callout: {
      kicker: "Please use AI",
      body: [
        "Solving these with an AI agent is the intended path, not a loophole. Bring whatever you already use and let it read the target. The fastest way to get a useful result is OWASP’s own ",
        { link: { href: SECURE_AGENT_PLAYBOOK_URL, label: "Secure Agent Playbook" } },
        ": structured, OWASP-grounded procedures for security code review, dependency and secrets scanning, and API assessment, mapped to the same Top 10 categories these challenges are graded against. Point it at your fork before you start reading files by hand.",
      ],
    },
    steps: (ctx) => [
      {
        title: "Sign in with GitHub",
        body: "Use the sign-in button in the header. Your GitHub login is how the leaderboard and your profile track your progress. The scorer credits points to the account that authors the pull request, so play from the same account you sign in with.",
      },
      {
        // Scores for this module arrive from GitHub through the poller, so
        // unlike quiz/classic there is no submission the box can refuse — a
        // teamless patch is silently ingested against no team. That is why
        // this step says "before you patch" instead of "or you'll be
        // refused" (see the team requirement in docs/operations.md).
        title: "Join a team, or play solo",
        body: "Scoring is per team. From your profile: create a team, join one by code or invite link, or hit Play solo for a one-click team of one. Do it before you patch — your PRs are scored either way, but points earned while you're on no team count toward no team's total.",
      },
      {
        title: "Pick a target and a challenge",
        body: `Browse the ${ctx.appCount} vulnerable ${ctx.appCount === 1 ? "app" : "apps"} on the Challenges page: ${ctx.appList}. Each has dozens of independent challenges at different difficulty levels; pick any one to start.`,
      },
      {
        title: "Find the vulnerability",
        body: "Work the target like a real audit: read the source, exercise the app, and identify the OWASP Top 10 flaw behind the challenge. Please use AI here. Point an agent at the codebase and have it do the analysis and draft the remediation. That's the intended workflow, not a shortcut around it.",
      },
      {
        title: "Patch it and open a pull request",
        body: `Fork the target's repo under the ${ctx.githubOrg} org, fix the vulnerability on a branch in your fork, and open a PR back against the repo's ${SCORING_BRANCH} branch. This is secure development practice, not flag hunting. The fix itself is the deliverable.`,
      },
      {
        title: "Get scored automatically",
        body: "A GitHub Action builds your patched app and runs the full regression suite against it. Every passing challenge test scores its points immediately: no manual grading, no waiting on an organizer. Pushing more fixes to the same PR re-scores it.",
      },
    ],
    // Two variants of the same loop (fork, branch, find the flaw, patch,
    // push, PR, get scored). The Juice Shop one is the Login Admin SQL
    // injection: the before/after mirrors routes/login.ts on the target's
    // default branch and the canonical parameterized-query fix, so a
    // contestant who follows it verbatim genuinely scores (and closes the
    // two sibling login challenges). The generic one names no app and no
    // app-specific path, for events where juice-shop isn't a target.
    example: (ctx) =>
      ctx.exampleVariant === "juice-shop"
        ? {
            kicker: "Worked example",
            heading: "Your first patch, end to end",
            anchor: "first-patch",
            lede: [
              "Here’s the whole loop on a real challenge: ",
              { em: "Login Admin" },
              " in Juice Shop, a classic SQL injection. Follow it verbatim to land your first points and see exactly what a scoring run looks like, then repeat the pattern on every other challenge.",
            ],
            steps: [
              {
                title: "Fork the target and clone your fork",
                body: `Fork ${ctx.githubOrg}/juice-shop on GitHub (or with the gh CLI), then clone it. The default branch is the one the scorer watches.`,
                code: `gh repo fork ${ctx.githubOrg}/juice-shop --clone
cd juice-shop`,
              },
              {
                title: "Create a branch for your fix",
                body: "One branch per fix keeps your PRs clean and easy to re-score.",
                code: "git checkout -b fix/login-sql-injection",
              },
              {
                title: "Find the flaw",
                body: "The Login Admin challenge (A05: Injection) lives in routes/login.ts. User input is concatenated straight into the SQL string, so an email like ' OR 1=1-- logs in as the first user in the table: the admin.",
                code: `// routes/login.ts: the vulnerable query
models.sequelize.query(
  \`SELECT * FROM Users WHERE email = '\${req.body.email || ''}'
    AND password = '\${security.hash(req.body.password || '')}'
    AND deletedAt IS NULL\`,
  { model: UserModel, plain: true }
)`,
              },
              {
                title: "Patch it",
                body: "Replace string interpolation with bind parameters. The database driver now treats the email and password strictly as data, so they can never rewrite the query itself.",
                code: `// routes/login.ts: parameterized fix
models.sequelize.query(
  'SELECT * FROM Users WHERE email = $1 AND password = $2 AND deletedAt IS NULL',
  {
    model: UserModel,
    plain: true,
    bind: [req.body.email || '', security.hash(req.body.password || '')]
  }
)`,
              },
              {
                title: "Commit and push to your fork",
                body: "Write the commit message like you would on a real security fix: say what was vulnerable and how the patch closes it.",
                code: `git add routes/login.ts
git commit -m "Fix SQL injection in login route with bind parameters"
git push -u origin fix/login-sql-injection`,
              },
              {
                title: "Open the PR against ctf",
                body: `The base repo is ${ctx.githubOrg}/juice-shop and the base branch is ${SCORING_BRANCH}. The scorer only watches that branch. The GitHub web UI's “Compare & pull request” button works too; just check the base branch.`,
                code: `gh pr create --repo ${ctx.githubOrg}/juice-shop --base ${SCORING_BRANCH} \\
  --title "Fix SQL injection in login route" \\
  --body "Replaced string-interpolated SQL with bind parameters."`,
              },
              {
                title: "Watch the scorer do its thing",
                body: "The ctf-score Action builds your patched app, boots it in a sandbox, and runs the challenge regression suite against it. When it finishes you'll get a “🏆 CTF Patch Score” comment on the PR, and your points appear on the leaderboard and your profile moments later.",
              },
            ],
            bonus: {
              kicker: "Bonus",
              body: [
                "That one-line fix doesn’t just close Login Admin. The same injection powers the ",
                { em: "Login Bender" },
                " and ",
                { em: "Login Jim" },
                " challenges, so a single parameterized query scores all three. Real fixes often cascade like this: patch the root cause, not the symptom.",
              ],
            },
          }
        : {
            kicker: "Worked example",
            heading: "Your first patch, end to end",
            anchor: "first-patch",
            lede: "Here’s the whole loop, end to end, on whichever target and challenge you pick: fork it, find the flaw, patch it, and open a PR. See exactly what a scoring run looks like, then repeat the pattern on every other challenge.",
            steps: [
              {
                title: "Fork the target and clone your fork",
                body: `Fork the target's repo under the ${ctx.githubOrg} org on GitHub (or with the gh CLI), then clone it. The default branch is the one the scorer watches.`,
                code: `gh repo fork ${ctx.githubOrg}/<target> --clone
cd <target>`,
              },
              {
                title: "Create a branch for your fix",
                body: "One branch per fix keeps your PRs clean and easy to re-score.",
                code: "git checkout -b fix/<short-description>",
              },
              {
                title: "Find the flaw",
                body: "Read the challenge description on the Challenges page, then trace it back to the vulnerable code in the target's source. Point an AI agent at the codebase if you want a head start on the audit.",
              },
              {
                title: "Patch it",
                body: "Apply the fix that closes the vulnerability class the challenge is testing for, without breaking the app's behavior for legitimate use.",
              },
              {
                title: "Commit and push to your fork",
                body: "Write the commit message like you would on a real security fix: say what was vulnerable and how the patch closes it.",
                code: `git add -A
git commit -m "Fix <vulnerability> in <component>"
git push -u origin fix/<short-description>`,
              },
              {
                title: "Open the PR against ctf",
                body: `The base repo is the target's fork under ${ctx.githubOrg} and the base branch is ${SCORING_BRANCH}. The scorer only watches that branch. The GitHub web UI's “Compare & pull request” button works too; just check the base branch.`,
                code: `gh pr create --repo ${ctx.githubOrg}/<target> --base ${SCORING_BRANCH} \\
  --title "Fix <vulnerability>" \\
  --body "Describe the fix and the vulnerability it closes."`,
              },
              {
                title: "Watch the scorer do its thing",
                body: "The ctf-score Action builds your patched app, boots it in a sandbox, and runs the challenge regression suite against it. When it finishes you'll get a “🏆 CTF Patch Score” comment on the PR, and your points appear on the leaderboard and your profile moments later.",
              },
            ],
            bonus: {
              kicker: "Bonus",
              body: "A root-cause fix like this often closes more than one challenge at once, if several exercise the same underlying flaw. Real fixes often cascade like that: patch the root cause, not the symptom, and check whether your score picked up more than the one challenge you were aiming at.",
            },
          },
    notes: [
      "Every push to an open PR re-runs the scorer, and the run evaluates your whole app, so you can keep stacking fixes on one branch or open a fresh PR per fix, whichever you prefer.",
      "Your best-ever result per challenge is what counts. A later fix always replaces an earlier miss; you can never lose points by trying.",
      "Points are credited to the GitHub account that authored the PR. A challenge patched by several teammates counts once for the team, so a team's total can be less than its members' points added together.",
    ],
    scoring:
      "Every challenge is worth a fixed number of points based on difficulty, and harder vulnerabilities pay out more. Points are awarded the moment your PR’s regression test passes, and your best-ever result for each challenge is what counts, so a later fix always replaces an earlier miss. Your live total, per-app breakdown, and patched and non-patched counts are visible on your profile once you’re signed in.",
    cta: { href: "/challenges", label: "Browse challenges" },
  },
  // Moved VERBATIM off app/(site)/rules/page.tsx. Every bullet here names
  // something only this module has — targets, forks, pull requests,
  // patches, hints — which is exactly why none of them can stay in the
  // platform's own list.
  rules: (ctx) => ({
    // The generic "your GitHub login is your identity" sentence lives in
    // the platform's own Teams list — three modules each restating it
    // rendered as three near-identical adjacent bullets. This module keeps
    // only the nuance the generic sentence cannot carry: points credit the
    // PULL REQUEST'S author, which is not automatically the signed-in
    // session.
    teams: [
      "Points for a patch credit the pull request's author — open every PR from the same GitHub account you sign in with, or your score lands on a row you can't see.",
    ],
    fairPlay: [
      `Only the ${ctx.appCount} challenge ${ctx.appCount === 1 ? "target" : "targets"} (${ctx.appList}) ${ctx.appCount === 1 ? "is" : "are"} in scope. Do not attack the CI scoring pipeline, the leaderboard, or other contestants' forks.`,
      "Submit your own work. Don't publish full solutions or patches for others to copy during the event.",
      "Automated mass-submission or spamming pull requests to farm scoring runs will get your account rate-limited or disqualified.",
      [
        { strong: "Please use AI." },
        " Finding and patching these vulnerabilities with an AI agent is the intended workflow, not a shortcut against the rules. It's the skill the event is built to teach. Start with OWASP's ",
        { link: { href: SECURE_AGENT_PLAYBOOK_URL, label: "Secure Agent Playbook" } },
        ".",
      ],
    ],
    conduct: [
      "Found a bug in a challenge, the scorer, or the site itself? Report it to an organizer instead of exploiting it for an unfair edge.",
    ],
    scoring: [
      "Each challenge is worth a fixed point value based on difficulty. Points post once the event receives your PR's passing result, usually a few minutes after the push, and that is the time a points tie is decided on.",
      "Your best-ever result per challenge counts. A later successful patch always replaces an earlier miss.",
      "Revealing a hint deducts points from your total, and hint purchases are final.",
    ],
  }),
  // Moved VERBATIM off app/(site)/faq/page.tsx, which was 100%
  // secure-development — and is in the HEADER NAV, so a quiz-only event
  // linked contestants straight to a page telling them to fork a target and
  // open a pull request. The platform keeps only the questions that hold on
  // any event (solo play, prizes, finding an organizer); everything that
  // names a fork, a PR, a hint or a scoring run is here.
  faq: (ctx) => ({
    gettingStarted: [
      {
        q: "Do I need experience to compete?",
        a: "No. Every target has challenges across a range of difficulty, and points scale with it. Start with a low-point challenge on any app and work up.",
      },
    ],
    prep: [
      {
        q: "What do I need to bring?",
        a: "Your own laptop with the dev tools you like to work in, a GitHub account, and a charger (outlets go fast). Everything else runs in your fork and in CI.",
      },
    ],
    playing: [
      {
        q: "How do I submit a solution?",
        a: [
          `There's no flag to type in. Fork the target's repo under the ${ctx.githubOrg} org, fix the vulnerability on a branch in your fork, and open a pull request against the repo's `,
          { code: SCORING_BRANCH },
          " branch. That's the only branch the scorer watches, and there is no per-challenge branch. A GitHub Action builds your app, runs the rubric, and posts your score on the PR, usually in two to five minutes. See ",
          { route: { href: "/how-to-play", label: "How to Play" } },
          " for a worked example.",
        ],
      },
      {
        q: "Do I need to run the target app locally?",
        a: "No. The scoring pipeline builds and runs your patched app in CI, so a PR is enough. Running it locally is just faster to iterate against while you work out the fix.",
      },
      {
        q: "Can I use AI tools to help?",
        a: [
          "Yes, ",
          { em: "please do" },
          ". Using AI to analyze and remediate these vulnerabilities is the skillset this event is built around, not something to hide or work around. Bring whatever you already use, and point it at your fork. OWASP's own ",
          { link: { href: SECURE_AGENT_PLAYBOOK_URL, label: "Secure Agent Playbook" } },
          " will get you further faster. It gives an agent structured, OWASP-grounded procedures for code review, dependency and secrets scanning, and API assessment, mapped to the same Top 10 categories these challenges are graded against.",
        ],
      },
      {
        q: "How is my progress tracked?",
        a: "Sign in with GitHub to claim your row on the live leaderboard and see a full per-app, per-challenge breakdown on your profile. Points are credited to the account that authored the pull request, so open your PRs from the same account you sign in with. Otherwise your score lands on a row you can't see.",
      },
      {
        q: "Are there hints?",
        a: `Some challenges offer one on your profile. Revealing a hint costs ${ctx.hintCost} points off your total, applied as soon as you reveal it, so save them for a challenge you're genuinely stuck on.`,
      },
      {
        q: "My PR passed but I didn't get points. What happened?",
        a: "Check the scoring comment on the PR. If it says the score wasn't recorded, that's on our side. Push another commit and the run will record it. If it shows zero challenges patched, the rubric still reproduced the vulnerability, so the fix didn't fully close it. Points also only count for the PR author's account.",
      },
      {
        q: "Can I retry a challenge I didn't solve?",
        a: "Yes, as many times as you like. Push another commit and it re-scores. Your best-ever result per challenge counts, so a later fix replaces an earlier miss and you can never lose points you've already banked, even if a later patch breaks a challenge you'd already solved.",
      },
    ],
  }),
  // Moved VERBATIM off app/(site)/terms/page.tsx. The scope statement is the
  // reason this block exists: on an event with no targets it rendered as
  // "your authorization to test covers the 0 challenge targets only: ," — a
  // legal scope clause that authorized nothing and read as broken, on the
  // page that tells contestants what they are permitted to attack.
  terms: (ctx) => ({
    eligibility: [
      "You need a GitHub account. Your GitHub login is your identity for scoring, so open every pull request from the account you sign in with. Points are credited to the PR author and cannot be moved between accounts afterwards.",
      "Organizers and anyone who worked on the challenge targets, the scorer, or the rubric may compete for fun but are not eligible for prizes.",
    ],
    scope: [
      `Your authorization to test covers the ${ctx.appCount} challenge ${ctx.appCount === 1 ? "target" : "targets"} only: ${ctx.appList}, in your own fork under the ${ctx.githubOrg} organization.`,
      "Explicitly out of scope: the CI scoring pipeline, the leaderboard, this website, the CTF Discord, and other contestants' accounts, forks, or machines. Testing any of those is not authorized by this event, and nothing here should be read as permission to do so.",
      "Found a real vulnerability in the scorer or this site? That is genuinely useful. Report it to an organizer rather than exploiting it. Doing so will not cost you anything.",
      "Automated mass-submission, or spamming pull requests to farm scoring runs, will get your account rate-limited or disqualified.",
    ],
    submissions: [
      `You submit work as a pull request against the target repository's ${SCORING_BRANCH} branch. Those repositories are OWASP projects under their own existing open-source licenses, and your contribution is offered under the license of the repository you are contributing to.`,
      "Submit your own work. Using AI tooling to find and fix vulnerabilities is expected and encouraged here (see the Rules), but passing off another contestant's patch as yours is not.",
      "Don't publish full solutions or patches for others to copy while the event is running. Afterwards, write up whatever you like.",
      "Organizers may reference or showcase submitted patches when talking about the event.",
    ],
    scoring: [
      "Each challenge is worth a fixed point value based on difficulty, awarded automatically when that challenge's regression test passes against your patched app. Your best-ever result per challenge counts.",
      "Revealing a hint deducts points from your leaderboard total. Hint purchases are final. There is no refund.",
    ],
  }),
  // Moved VERBATIM off app/not-found.tsx, where it was hardcoded alongside
  // a card linking to /challenges — a route that 404s on an event without
  // this module, reached from the 404 page itself.
  routeCard: (ctx) =>
    `Every challenge across the ${ctx.appCount} ${ctx.appCount === 1 ? "target" : "targets"}.`,
  // Organizer-facing setup checklist (module contract §5.9). Every step
  // here is a `ctf-setup.sh`/GitHub/`.env` step — this is the one
  // module the panel cannot set up, only tune — so none carries a `check`:
  // the app cannot see a fork or an App installation and must not pretend
  // to. Steps and their order follow docs/hosting.md's quickstart.
  setup: (ctx) => ({
    experience: `Contestants fork ${ctx.appList} under the ${ctx.githubOrg} GitHub org, patch a real vulnerability, and open a pull request. A GitHub Action in the fork scores the patch and the score reaches the leaderboard through the poller.`,
    steps: [
      {
        title: "Build and push the scorer image",
        where: "outside",
        body: [
          "Pin ",
          { code: "linux/amd64" },
          " and point ",
          { code: "SCORE_IMAGE" },
          " in .env at it. The ",
          { code: "ctf-setup.sh" },
          " wizard does this for you — see ",
          { link: { href: `${DOCS_URL}hosting#quickstart-zero-to-a-scored-event`, label: "the hosting quickstart" } },
          ".",
        ],
      },
      {
        title: "Create the GitHub org and the sync GitHub App",
        where: "outside",
        body: [
          `The org (${ctx.githubOrg}) is created by hand on GitHub. `,
          { code: "ctf-setup.sh app-manifest" },
          " opens the App form and ",
          { code: "app-config" },
          " wires its key into .env; the App must be installed on the org.",
        ],
      },
      {
        title: "Provision the org with ctf-setup.sh org",
        where: "outside",
        body: [
          "Forks all six targets, commits the scoring workflow to every fork, mirrors the scorer image into the org, then prints the steps only GitHub's UI can finish. Which of the six contestants see is this tab's Targets list. ",
          { code: "ctf-setup.sh doctor" },
          " verifies the result.",
        ],
      },
      {
        title: "Set ADMIN_LOGINS in .env",
        where: "outside",
        body: "Without it nobody is an admin, even the deployer. It's a runtime env var, not baked into the image, so a change needs a restart, not a rebuild.",
      },
      {
        title: "Set the re-run cooldown",
        where: "panel",
        body: "Below on this tab. The hint policy — price and gating — is event-wide and lives in the Hints section of the Event tab.",
      },
    ],
    midEvent: {
      safe: [
        "The re-run cooldown. It takes effect on each fork's next push.",
        "The hint policy on the Event tab. It takes effect immediately.",
        "This module's title. It renames the tab, the nav link and the challenges page on the next request.",
        [
          { strong: "Freeze scoring" },
          " on the Event tab pauses ingestion only: forks keep judging and commenting on PRs, and the poller picks up where it left off when you unfreeze.",
        ],
      ],
      unsafe: [
        "Adding a target beyond the six ctf-setup.sh org already forked and provisioned for this org — that needs a re-run of ctf-setup.sh org, not an admin-panel toggle. Which of the six is visible to contestants is otherwise a runtime setting on this tab's Targets list, safe to flip any time.",
        "Switching this module off or on: a normal toggle now (issue #386), refused only when this deployment has no scorer image (SCORE_IMAGE unset) — the scorer and sync containers are chosen when the stack comes up, not from here.",
        "A master reset while PRs still carry score comments. The poller re-ingests them once you unfreeze unless the comments are removed too.",
      ],
    },
    docs: { href: `${DOCS_URL}operations#organizer-admin-panel`, label: "The organizer admin panel in the operations guide" },
  }),
};
