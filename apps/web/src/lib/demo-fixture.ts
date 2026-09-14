// Bundled demo dataset for the DEMO_MODE 'Seed demo data' admin action.
// Challenge ids are real lowercased catalogue keys so the scorer awards points
// (foreign ids are skipped by buildLeaderboard). Regenerate if those keys change.
// NOT loaded in production paths — the seed route is DEMO_MODE + admin gated.

export type DemoContestant = { login: string; solves: Record<string, string[]> };
export type DemoTeam = { slug: string; name: string; captain: string; members: string[] };

// ai (externally hosted AI/LLM challenge) demo data (DEMO_MODE 'Seed demo
// data', ai module only). Mirrors the `AiChallenge` shape ai-store.ts expects
// — see its header comment for the key layout and the four-hash secrecy
// boundary. `flag` and `signingKey` are NOT part of that public shape; they
// exist here only so seedDemoData can derive `ctf:ai:flag` / `ctf:ai:flagnorm`
// (for a `mode: "flag"` challenge) and `ctf:ai:signkey` the same way
// `upsertAiChallenge` does, except the signing key is a fixed literal rather
// than a fresh `generateSigningKey()` mint — the same reproducibility choice
// the seed makes for classic's flag. `flag` is empty for a `mode: "event"`
// challenge, matching how an event-only challenge is authored: signed events
// assert the solve, so there is no flag to grade.
//
// NO CHALLENGE HERE IS `mode: "event"`, deliberately (issue #355). An
// event-graded challenge can only be solved by an external arena POSTing a
// signed event, and a demo dataset cannot ship one — the launch URLs below
// point at a reserved documentation domain that does not resolve. Seeding an
// event-mode challenge therefore put a 400-point row on the board that nobody
// could clear: no flag form, and a Launch button that dead-ends. Both demo
// challenges are flag-gradable so the board plays end to end. What event mode
// looks like is documented in docs/ai-module.md §5, which is the right place
// for it — an honest demo of that mode needs a second system.
export type DemoAiChallenge = {
  id: string;
  title: string;
  category: string;
  description: string;
  points: number;
  order: number;
  mode: "flag" | "event" | "both";
  urlTemplate: string;
  flag: string;
  signingKey: string;
  caseSensitive?: boolean;
  hint?: string;
};

// Categories, in the display order the demo board renders them.
export const DEMO_AI_CATEGORIES: string[] = ["AI"];

export const DEMO_AI_CHALLENGES: DemoAiChallenge[] = [
  {
    id: "ai-prompt-injection",
    title: "Prompt Injection 101",
    category: "AI",
    order: 1,
    points: 250,
    mode: "flag",
    urlTemplate: "https://ai-demo.example.org/launch?token={token}",
    description:
      "The assistant behind this link has a **system prompt** it isn't supposed to repeat. Convince it to " +
      "recite its own instructions — the flag is hiding in plain sight once it does.",
    flag: "ctfbox{Ignore_All_Previous_Instructions}",
    signingKey: "aik_demo0000000000000000000000000000000000000000001",
    hint: "Ask it to summarize everything it was told before this conversation started.",
  },
  {
    id: "ai-jailbreak-arena",
    title: "Jailbreak Arena",
    category: "AI",
    order: 2,
    points: 400,
    // `both`, not `event` — see the header. The admin panel labels this mode
    // "Either — flag or external event"; the stored value is `both`.
    mode: "both",
    urlTemplate: "https://ai-demo.example.org/arena?token={token}",
    description:
      "Talk the model out of its own safety rules. In a **real** event this one grades itself — the arena " +
      "decides whether you managed it and reports the solve back to the box over a signed API, with no flag " +
      "to copy. This demo has no arena behind it, so it accepts a flag too and the board stays playable.",
    flag: "ctfbox{Safety_Rails_Are_Suggestions}",
    signingKey: "aik_demo0000000000000000000000000000000000000000002",
  },
];

export type DemoAiSolve = { login: string; challengeId: string };

// Spread across several demo contestants so the ai board's contribution to
// the combined leaderboard is visible. Every (login, challengeId) pair is
// unique, same rule as DEMO_CLASSIC_SOLVES, so solvecount is just a row count.
export const DEMO_AI_SOLVES: DemoAiSolve[] = [
  { login: "neo-anderson", challengeId: "ai-prompt-injection" },
  { login: "trinity-h", challengeId: "ai-prompt-injection" },
  { login: "kevin-mitnick", challengeId: "ai-jailbreak-arena" },
  { login: "grace-hopper", challengeId: "ai-prompt-injection" },
  { login: "grace-hopper", challengeId: "ai-jailbreak-arena" },
];

// Classic (jeopardy-style flag) demo data (DEMO_MODE 'Seed demo data', classic
// module only). Mirrors the `Challenge` shape classic-store.ts expects — see
// its header comment for the key layout. `flag` is NOT part of that public
// shape; it exists here only so seedDemoData can derive `ctf:classic:flag`
// (as authored) and `ctf:classic:flagnorm` (via `normalizeFlag`) the same way
// `upsertChallenge` does.
export type DemoChallenge = {
  id: string;
  title: string;
  category: string;
  description: string;
  points: number;
  order: number;
  flag: string;
};

// Categories, in the display order the demo board renders them.
export const DEMO_CLASSIC_CATEGORIES: string[] = ["Web", "Crypto", "Forensics", "Recon"];

// Descriptions deliberately exercise the markdown subset markdown.ts actually
// parses (bold, italic, inline code, a fenced code block, a list, an
// https:// link) so the seeded board also demonstrates the renderer — see
// markdown.ts's header comment for exactly what is (and is not) supported.
export const DEMO_CHALLENGES: DemoChallenge[] = [
  {
    id: "web-robots-only",
    title: "Robots Only",
    category: "Web",
    order: 1,
    points: 50,
    description:
      "The site's root **disallows** crawling for a reason. Check `/robots.txt` — nothing is ever *truly* " +
      "hidden from a determined recon pass. See the [OWASP Testing Guide](https://owasp.org/www-project-web-security-testing-guide/) " +
      "for the general approach.",
    flag: "ctfbox{Robots_Dot_Txt_Never_Lies}",
  },
  {
    id: "web-hidden-comment",
    title: "Hidden in Plain Sight",
    category: "Web",
    order: 2,
    points: 150,
    description:
      "Somebody left a debug comment in the markup. View source and look for anything wrapped in `<!-- -->`. " +
      "Typical spots to check:\n\n" +
      "- Response headers\n" +
      "- HTML comments\n" +
      "- JS source maps\n\n" +
      "Once you find it, submit the flag exactly as shown.",
    flag: "ctfbox{Html_Comments_Are_Forever}",
  },
  {
    id: "web-cookie-jar",
    title: "Cookie Jar",
    category: "Web",
    order: 3,
    points: 300,
    description:
      "This app trusts a client-supplied session cookie a little too much. Decode it, tweak the role field, " +
      "and re-encode.\n\n" +
      "```\n" +
      "echo 'eyJhbGciOiJIUzI1NiJ9...' | base64 -d\n" +
      "```\n\n" +
      "The **payload** is not signed the way you'd expect.",
    flag: "ctfbox{Unsigned_Role_Swap}",
  },
  {
    id: "crypto-caesar-whisper",
    title: "Caesar's Whisper",
    category: "Crypto",
    order: 1,
    points: 75,
    description:
      "An old-school substitution hides the flag: `synt{arkg_fghcvq}` — shift each letter back by 13 and " +
      "you're done. *ROT13 never goes out of style.*",
    flag: "ctfbox{Rot13_Is_Not_Encryption}",
  },
  {
    id: "crypto-base-case",
    title: "Base Case",
    category: "Crypto",
    order: 2,
    points: 125,
    description:
      "Multiple layers of encoding stand between you and the flag.\n\n" +
      "```\n" +
      "echo '<encoded blob here>' | base64 -d | base64 -d\n" +
      "```\n\n" +
      "Keep decoding until it stops looking like `base64`.",
    flag: "ctfbox{Base64_All_The_Way_Down}",
  },
  {
    id: "crypto-rsa-101",
    title: "RSA 101",
    category: "Crypto",
    order: 3,
    points: 400,
    description:
      "A tiny modulus makes this **breakable** by hand. Factor `n`, derive `d`, and decrypt `c`. Tools like " +
      "[FactorDB](https://factordb.com) can save you the trouble.",
    flag: "ctfbox{Small_Primes_Big_Problems}",
  },
  {
    id: "forensics-metadata-leak",
    title: "Metadata Leak",
    category: "Forensics",
    order: 1,
    points: 100,
    description:
      "A photo says more than it should. Pull the EXIF data and look for anything that isn't a camera " +
      "setting:\n\n" +
      "- GPS coordinates\n" +
      "- Software field\n" +
      "- Comment field\n\n" +
      "`exiftool` is your friend here.",
    flag: "ctfbox{Exif_Never_Forgets}",
  },
  {
    id: "forensics-packet-peek",
    title: "Packet Peek",
    category: "Forensics",
    order: 2,
    points: 350,
    description:
      "A capture from the CTF's own network holds a plaintext credential. Filter for it:\n\n" +
      "```\n" +
      'tcp.port == 21 && ftp.request.command == "PASS"\n' +
      "```\n\n" +
      "*FTP never learned to keep a secret.*",
    flag: "ctfbox{Plaintext_Ftp_Strikes_Again}",
  },
  {
    id: "recon-subdomain-sweep",
    title: "Subdomain Sweep",
    category: "Recon",
    order: 1,
    points: 200,
    description:
      "The main domain is locked down, but a forgotten subdomain never got the memo. Enumerate with your " +
      "favorite tool, or just check [crt.sh](https://crt.sh) for certificate transparency logs — " +
      "**passive recon** beats brute force every time.",
    flag: "ctfbox{Forgotten_Subdomain_Found}",
  },
  {
    id: "recon-whois-wonders",
    title: "Whois Wonders",
    category: "Recon",
    order: 2,
    points: 500,
    description:
      "Historical WHOIS records sometimes outlive a takedown. Look for a registrant email that was reused " +
      "elsewhere — that's the pivot. Combine it with:\n\n" +
      "- Search engines\n" +
      "- Paste sites\n" +
      "- Old social profiles\n\n" +
      "Patience beats tooling on this one.",
    flag: "ctfbox{Whois_History_Repeats}",
  },
];

export type DemoClassicSolve = { login: string; challengeId: string };

// Spread across several demo contestants (and across both members of more
// than one team) so the classic board's contribution to the combined
// leaderboard is visible, not just an authored board with nobody on it.
// Every (login, challengeId) pair here is unique so solvecount can be derived
// directly as "how many rows name this challengeId" without a dedupe step.
export const DEMO_CLASSIC_SOLVES: DemoClassicSolve[] = [
  { login: "neo-anderson", challengeId: "web-robots-only" },
  { login: "neo-anderson", challengeId: "web-hidden-comment" },
  { login: "neo-anderson", challengeId: "crypto-caesar-whisper" },
  { login: "trinity-h", challengeId: "web-robots-only" },
  { login: "trinity-h", challengeId: "crypto-base-case" },
  { login: "kevin-mitnick", challengeId: "crypto-caesar-whisper" },
  { login: "kevin-mitnick", challengeId: "forensics-metadata-leak" },
  { login: "kevin-mitnick", challengeId: "recon-subdomain-sweep" },
  { login: "grace-hopper", challengeId: "web-hidden-comment" },
  { login: "grace-hopper", challengeId: "web-cookie-jar" },
  { login: "grace-hopper", challengeId: "forensics-packet-peek" },
  { login: "ada-lovelace", challengeId: "crypto-base-case" },
  { login: "ada-lovelace", challengeId: "recon-subdomain-sweep" },
  { login: "morpheus-z", challengeId: "web-robots-only" },
];

// Quiz demo data (DEMO_MODE 'Seed demo data', quiz module only). Mirrors the
// shape quiz-store.ts's `Question`/correct-answer-key expects: `correct` is
// NOT part of the public `Question` shape written to `ctf:quiz:questions` —
// it is used only to derive `ctf:quiz:key`'s sorted, deduped array (the same
// recipe `upsertQuestion` applies) and each demo answer's banked `choices`.
export type DemoChoice = { id: string; label: string };
export type DemoQuestionType = "single" | "multi";
export type DemoQuestion = {
  id: string;
  prompt: string;
  type: DemoQuestionType;
  choices: DemoChoice[];
  points: number;
  order: number;
  /** Correct choice id(s) — one for `"single"`, two or more for `"multi"`. */
  correct: string[];
};

export const DEMO_QUESTIONS: DemoQuestion[] = [
  {
    id: "xss-basics",
    prompt: "What does XSS stand for?",
    type: "single",
    order: 1,
    points: 50,
    choices: [
      { id: "a", label: "Cross-Site Scripting" },
      { id: "b", label: "XML Signature Exchange" },
      { id: "c", label: "Cross-Server Xchange" },
      { id: "d", label: "Extended Session Storage" },
    ],
    correct: ["a"],
  },
  {
    id: "injection-types",
    prompt: "Which of these are injection vulnerabilities? (choose all that apply)",
    type: "multi",
    order: 2,
    points: 100,
    choices: [
      { id: "a", label: "SQL Injection" },
      { id: "b", label: "Command Injection" },
      { id: "c", label: "Cross-Site Scripting" },
      { id: "d", label: "Broken Access Control" },
    ],
    correct: ["a", "b"],
  },
  {
    id: "owasp-top10-2021",
    prompt: "Which OWASP Top 10 (2021) category covers broken access control?",
    type: "single",
    order: 3,
    points: 50,
    choices: [
      { id: "a", label: "A01:2021" },
      { id: "b", label: "A03:2021" },
      { id: "c", label: "A05:2021" },
      { id: "d", label: "A07:2021" },
    ],
    correct: ["a"],
  },
  {
    id: "secure-headers",
    prompt: "Which HTTP response headers help mitigate common web attacks? (choose all that apply)",
    type: "multi",
    order: 4,
    points: 100,
    choices: [
      { id: "a", label: "Content-Security-Policy" },
      { id: "b", label: "X-Frame-Options" },
      { id: "c", label: "Set-Cookie" },
      { id: "d", label: "Strict-Transport-Security" },
    ],
    correct: ["a", "b", "d"],
  },
  {
    id: "csrf-defense",
    prompt: "What is the primary defense against CSRF attacks?",
    type: "single",
    order: 5,
    points: 75,
    choices: [
      { id: "a", label: "Anti-CSRF tokens" },
      { id: "b", label: "Rate limiting" },
      { id: "c", label: "Password hashing" },
      { id: "d", label: "CORS headers" },
    ],
    correct: ["a"],
  },
];

export type DemoQuizAnswer = { login: string; questionId: string };

// Spread across every demo contestant (not just the top solver) so DEMO_MODE
// shows a genuinely combined leaderboard — patching points AND quiz points
// both moving the same board.
export const DEMO_QUIZ_ANSWERS: DemoQuizAnswer[] = [
  { login: "neo-anderson", questionId: "xss-basics" },
  { login: "neo-anderson", questionId: "injection-types" },
  { login: "neo-anderson", questionId: "csrf-defense" },
  { login: "trinity-h", questionId: "xss-basics" },
  { login: "trinity-h", questionId: "owasp-top10-2021" },
  { login: "kevin-mitnick", questionId: "injection-types" },
  { login: "kevin-mitnick", questionId: "secure-headers" },
  { login: "grace-hopper", questionId: "xss-basics" },
  { login: "grace-hopper", questionId: "secure-headers" },
  { login: "grace-hopper", questionId: "csrf-defense" },
  { login: "ada-lovelace", questionId: "owasp-top10-2021" },
  { login: "morpheus-z", questionId: "injection-types" },
];

export const DEMO_CONTESTANTS: DemoContestant[] = [
  {
    "login": "neo-anderson",
    "solves": {
      "juice-shop": [
        "challenge-12-security-through-obscurity",
        "challenge-59-outdated-allowlist",
        "challenge-1-password-hash-leak",
        "challenge-16-nautical-mystery",
        "challenge-45-login-admin",
        "challenge-5-admin-section",
        "challenge-66-reflected-xss",
        "challenge-10-mint-the-honey-pot"
      ],
      "dvwa": [
        "challenge-1-brute-force-low",
        "challenge-2-command-injection-low",
        "challenge-3-csrf-low",
        "challenge-4-file-inclusion-low",
        "challenge-5-file-upload-low",
        "challenge-6-insecure-captcha-low",
        "challenge-7-sql-injection-low",
        "challenge-8-sql-injection-blind-low",
        "challenge-9-weak-session-ids-low",
        "challenge-10-xss-dom-low"
      ],
      "vampi": [
        "challenge-1-excessive-data-exposure",
        "challenge-2-user-and-pass-enumeration",
        "challenge-3-sqli",
        "challenge-4-mass-assignment",
        "challenge-5-bola",
        "challenge-6-unauthorized-password-change",
        "challenge-7-weak-jwt",
        "challenge-8-regex-dos",
        "challenge-9-no-rate-limit"
      ],
      "webgoat": [
        "challenge-15-authorization-bypass",
        "challenge-10-field-restriction-bypass",
        "challenge-11-frontend-validation-bypass",
        "challenge-40-csrf-flag",
        "challenge-39-csrf-feedback",
        "challenge-37-csrf-login"
      ]
    }
  },
  {
    "login": "trinity-h",
    "solves": {
      "juice-shop": [
        "challenge-12-security-through-obscurity",
        "challenge-59-outdated-allowlist",
        "challenge-1-password-hash-leak",
        "challenge-16-nautical-mystery",
        "challenge-45-login-admin",
        "challenge-5-admin-section"
      ],
      "vulnerableapp": [
        "challenge-1-authentication-level-1",
        "challenge-2-authentication-level-2",
        "challenge-3-authentication-level-3",
        "challenge-4-authentication-level-7",
        "challenge-5-authentication-level-8",
        "challenge-6-authentication-level-10",
        "challenge-7-blind-sqli-level-1",
        "challenge-8-blind-sqli-level-2",
        "challenge-9-cache-poisoning-level-1",
        "challenge-10-cache-poisoning-level-2",
        "challenge-11-cache-poisoning-level-3",
        "challenge-12-cache-poisoning-level-4"
      ],
      "securityshepherd": [
        "challenge-1-broken-crypto-3",
        "challenge-2-broken-crypto-4",
        "challenge-3-csrf-1",
        "challenge-4-csrf-2",
        "challenge-5-csrf-3"
      ]
    }
  },
  {
    "login": "kevin-mitnick",
    "solves": {
      "dvwa": [
        "challenge-1-brute-force-low",
        "challenge-2-command-injection-low",
        "challenge-3-csrf-low",
        "challenge-4-file-inclusion-low",
        "challenge-5-file-upload-low",
        "challenge-6-insecure-captcha-low",
        "challenge-7-sql-injection-low",
        "challenge-8-sql-injection-blind-low",
        "challenge-9-weak-session-ids-low"
      ],
      "webgoat": [
        "challenge-15-authorization-bypass",
        "challenge-10-field-restriction-bypass",
        "challenge-11-frontend-validation-bypass",
        "challenge-40-csrf-flag",
        "challenge-39-csrf-feedback",
        "challenge-37-csrf-login",
        "challenge-38-csrf-review",
        "challenge-78-xss-stego-challenge"
      ],
      "securityshepherd": [
        "challenge-1-broken-crypto-3",
        "challenge-2-broken-crypto-4",
        "challenge-3-csrf-1",
        "challenge-4-csrf-2",
        "challenge-5-csrf-3",
        "challenge-6-csrf-4"
      ]
    }
  },
  {
    "login": "grace-hopper",
    "solves": {
      "juice-shop": [
        "challenge-12-security-through-obscurity",
        "challenge-59-outdated-allowlist",
        "challenge-1-password-hash-leak",
        "challenge-16-nautical-mystery",
        "challenge-45-login-admin"
      ],
      "webgoat": [
        "challenge-15-authorization-bypass",
        "challenge-10-field-restriction-bypass",
        "challenge-11-frontend-validation-bypass",
        "challenge-40-csrf-flag",
        "challenge-39-csrf-feedback",
        "challenge-37-csrf-login",
        "challenge-38-csrf-review",
        "challenge-78-xss-stego-challenge",
        "challenge-79-sql-injection-challenge",
        "challenge-80-password-reset-git-challenge"
      ],
      "vampi": [
        "challenge-1-excessive-data-exposure",
        "challenge-2-user-and-pass-enumeration",
        "challenge-3-sqli",
        "challenge-4-mass-assignment",
        "challenge-5-bola",
        "challenge-6-unauthorized-password-change"
      ]
    }
  },
  {
    "login": "ada-lovelace",
    "solves": {
      "vulnerableapp": [
        "challenge-1-authentication-level-1",
        "challenge-2-authentication-level-2",
        "challenge-3-authentication-level-3",
        "challenge-4-authentication-level-7",
        "challenge-5-authentication-level-8",
        "challenge-6-authentication-level-10",
        "challenge-7-blind-sqli-level-1",
        "challenge-8-blind-sqli-level-2",
        "challenge-9-cache-poisoning-level-1",
        "challenge-10-cache-poisoning-level-2",
        "challenge-11-cache-poisoning-level-3"
      ],
      "dvwa": [
        "challenge-1-brute-force-low",
        "challenge-2-command-injection-low",
        "challenge-3-csrf-low",
        "challenge-4-file-inclusion-low",
        "challenge-5-file-upload-low",
        "challenge-6-insecure-captcha-low"
      ]
    }
  },
  {
    "login": "morpheus-z",
    "solves": {
      "juice-shop": [
        "challenge-12-security-through-obscurity",
        "challenge-59-outdated-allowlist",
        "challenge-1-password-hash-leak",
        "challenge-16-nautical-mystery"
      ],
      "vulnerableapp": [
        "challenge-1-authentication-level-1",
        "challenge-2-authentication-level-2",
        "challenge-3-authentication-level-3",
        "challenge-4-authentication-level-7",
        "challenge-5-authentication-level-8",
        "challenge-6-authentication-level-10",
        "challenge-7-blind-sqli-level-1"
      ]
    }
  }
];

export const DEMO_TEAMS: DemoTeam[] = [
  {
    "slug": "zero-cool",
    "name": "Zero Cool",
    "captain": "neo-anderson",
    "members": [
      "neo-anderson",
      "trinity-h"
    ]
  },
  {
    "slug": "the-plague",
    "name": "The Plague",
    "captain": "kevin-mitnick",
    "members": [
      "kevin-mitnick",
      "morpheus-z"
    ]
  },
  {
    "slug": "byte-me",
    "name": "Byte Me",
    "captain": "grace-hopper",
    "members": [
      "grace-hopper",
      "ada-lovelace"
    ]
  }
];

// Sponsors (DEMO_MODE 'Seed demo data'). A platform feature, not a module —
// seeded regardless of which modules are enabled, mirroring how sponsors
// themselves carry no module gate anywhere else (issue #405). Names/urls are
// placeholder — `.example` is the IANA-reserved TLD for exactly this, so
// nothing here resolves to (or could be mistaken for) a real organization.
//
// Each carries a real, genuinely decodable 160x56 solid-color PNG (one flat
// color per tier — gold/silver/teal), base64-inlined below. `admin-store.ts`'s
// seedDemoData derives `bytes`/`etag` from these bytes itself (the same
// sha256-of-decoded-bytes recipe sponsors-store.ts uses), so nothing here
// needs to hand-carry a hash that could drift from the actual pixels.
export type DemoSponsorLogo = { data: string; type: "image/png"; w: number; h: number };

export type DemoSponsor = {
  id: string;
  name: string;
  url: string;
  blurb: string;
  tier: "gold" | "silver" | "community";
  order: number;
  logo: DemoSponsorLogo;
};

export const DEMO_SPONSORS: DemoSponsor[] = [
  {
    "id": "acme-security-demo",
    "name": "Acme Security",
    "url": "https://acme-security.example",
    "blurb": "Placeholder gold sponsor for demo mode.",
    "tier": "gold",
    "order": 0,
    "logo": {
      "data": "iVBORw0KGgoAAAANSUhEUgAAAKAAAAA4CAIAAAD1mGRUAAAAnklEQVR4nO3RAQkAIBDAwG9hfUMZyBQijIMLMNicvQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXYCsEK8s9uBQAAAAASUVORK5CYII=",
      "type": "image/png",
      "w": 160,
      "h": 56
    }
  },
  {
    "id": "widgetsoft-labs-demo",
    "name": "Widgetsoft Labs",
    "url": "https://widgetsoft.example",
    "blurb": "Placeholder silver sponsor for demo mode.",
    "tier": "silver",
    "order": 1,
    "logo": {
      "data": "iVBORw0KGgoAAAANSUhEUgAAAKAAAAA4CAIAAAD1mGRUAAAAnklEQVR4nO3RQQkAMAzAwPp30e9UTsUYhIMTEMjsHsLmewFPGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncJzBcQbHGRxncNwFBFxH7qP0SzcAAAAASUVORK5CYII=",
      "type": "image/png",
      "w": 160,
      "h": 56
    }
  },
  {
    "id": "northwind-foundation-demo",
    "name": "Northwind Foundation",
    "url": "https://northwind.example",
    "blurb": "Placeholder community sponsor for demo mode.",
    "tier": "community",
    "order": 2,
    "logo": {
      "data": "iVBORw0KGgoAAAANSUhEUgAAAKAAAAA4CAIAAAD1mGRUAAAAn0lEQVR4nO3RUQkAIBTAwBfC/p9mMJ4pRBgHF2CwWWcTNt8LeMrgOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjLtKVmO/ETDLZAAAAAElFTkSuQmCC",
      "type": "image/png",
      "w": 160,
      "h": 56
    }
  }
];
