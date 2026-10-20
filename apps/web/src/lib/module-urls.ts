// The three values the module registry's copy links into, split from
// lib/modules.ts (#504 M10) so each per-module def can be its own file. A def
// that imported them from `@/lib/modules` would close a cycle
// (modules.ts -> module-defs/<id> -> modules.ts), and unlike `ModuleDef` —
// which every def takes back as a type import, erased at compile time — these
// are VALUES, so that loop would throw at init rather than merely look
// untidy.
//
// Dependency-free by contract, the one activity-keys.ts keeps. `modules.ts`
// re-exports all three, so their callers keep one import: `site.ts`, the home
// page and the AI setup component all still read them from `@/lib/modules`.

/** OWASP's own playbook for pointing an AI agent at a codebase. Needed by
 *  `secure-development`'s def (its recommendation, and its copy links to it)
 *  and by `site.ts`, which re-exports it as `event.secureAgentPlaybookUrl` —
 *  so it lives in this leaf that both can import, and there is still exactly
 *  one place the URL is written down. */
export const SECURE_AGENT_PLAYBOOK_URL = "https://github.com/OWASP/secure-agent-playbook";

/** The published docs site (GitHub Pages build of `docs/`). Written down once,
 *  for the same reason the playbook URL is: every module def's setup block
 *  links into it, and `site.ts` already imports `lib/modules.ts`, which
 *  re-exports this. Pages serves `docs/<name>.md` at `<DOCS_URL><name>`,
 *  extensionless. */
export const DOCS_URL = "https://owasp.github.io/owasp-ctf-in-a-box/";

/** The branch every provisioned target repo scores from — `ctf-setup.sh`'s
 *  `ctf-branch` step creates it and `drop-old` deletes `master`/`main`, so a
 *  PR against `main` has no base branch to land on. Written down once here so
 *  the How to Play / FAQ / Terms copy in the module defs can't drift from it
 *  again; `ctf-setup.sh` has no equivalent named constant of its own (it
 *  compares the literal string), so this is the only place the value is
 *  written down on the app side. */
export const SCORING_BRANCH = "ctf";
