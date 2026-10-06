#!/usr/bin/env node
// Enforces the comment policy AGENTS.md states: a comment explains the
// present — why this shape, what must stay true, what breaks if it changes —
// and never narrates a change (history, "now X instead of Y") or cites an
// issue/PR as provenance. Those belong to the commit that made the change
// and, once the change is a decision, to an ADR in docs/decisions.md.
//
// Scope is deliberately the pre-v0.7.0 audit's top 20 files (the 20 files
// with the most comment lines at the commit the audit read, 09a48384): that
// is the set the trim cleaned, and a repo-wide sweep would fail on files the
// trim never reached. AGENTS.md governs the rest until they are trimmed.
// Narration — a comment that restates what the next line does — is left to
// reviewers: no regex can tell "loop over the teams" from the sentence above
// it that earns its place.
//
// What is flagged, per comment line:
//   history        previously, formerly, used to <any verb>, no longer,
//                  anymore, (was|were) renamed, renamed from,
//                  (since|after|before|as of) #N, <verb> in #N
//   restatement    now (returns|reads|writes|throws|sets|calls|...)
//   provenance     (issue #N), (#N), "issue #N", "see #N", "closes #N", a
//                  comment opening "#N:" — a ref that carries no rationale
// A parenthetical that ALSO names an ADR or a docs path (e.g. "#464, ADR 59")
// is a pointer to current rationale, so it is not matched. So is one glued to
// a backticked identifier (`scoringClosure` (#567)): the ref sits on the
// symbol as its label, not behind the sentence's claim, and the same ref
// anywhere else on the line is still provenance.
//
// Comment lines are found without a parser: a line whose first non-space is
// the language's comment marker, minus shebangs and directive comments
// (// eslint-disable, # shellcheck, // @ts-expect-error), which are load-
// bearing. Shell heredoc bodies are skipped — a generated workflow's `#`
// lines belong to the file being generated, not to this one.
//
// Usage: node scripts/check-comment-policy.mjs [repo-root]
//        node scripts/check-comment-policy.mjs --list   (the audited paths)
// Exits 1 naming every problem, 0 with "comment policy: ok".
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(fileURLToPath(import.meta.url), "..", ".."));
const read = (rel) => readFileSync(join(root, rel), "utf8");

// The audited top 20, ranked by comment-line count at 09a48384 (the
// pre-v0.7.0 audit's commit). A file that is gone is a problem, not a skip:
// the list is only useful while it still names real files.
const AUDITED = [
  "setup/ctf-setup.sh",
  "apps/web/src/lib/classic-store.ts",
  "apps/web/src/lib/admin-store.ts",
  "apps/web/src/lib/modules.ts",
  "deploy/fly/deploy.sh",
  "apps/web/src/lib/quiz-store.ts",
  "apps/web/src/lib/ai-store.ts",
  "apps/web/src/lib/leaderboard/module-contributions.ts",
  "apps/web/src/app/(site)/admin/admin-controls.tsx",
  "apps/web/src/lib/event-store.ts",
  "scripts/acceptance-ai-only.sh",
  ".github/workflows/ci.yml",
  "apps/web/src/lib/metrics-store.ts",
  "apps/web/src/lib/__tests__/admin-store.seed.test.ts",
  "deploy/fly/render-compose.sh",
  "apps/web/src/lib/leaderboard/__tests__/module-contributions.test.ts",
  "apps/web/src/lib/team-store.ts",
  "apps/web/src/app/(site)/admin/__tests__/admin-controls.test.tsx",
  "scripts/load-seed.mjs",
  "apps/web/src/lib/admin-ops-store.ts",
];

// The manifest doubles as the copy list for scripts/test/check-comment-policy.bats,
// so the suite's scratch root and this scan can never disagree about scope.
if (process.argv.includes("--list")) {
  console.log(AUDITED.join("\n"));
  process.exit(0);
}

const POLICY_LEAD = "**Comments explain the present, not the past, and not the code.**";

const RULES = [
  ["history", /\bpreviously\b/i],
  ["history", /\bformerly\b/i],
  ["history", /\bused to\b/i],
  ["history", /\bno longer\b/i],
  ["history", /\banymore\b/i],
  ["history", /\b(?:was|were) renamed\b|\brenamed from\b/i],
  ["history", /\b(?:since|after|before|as of) #\d+\b/i],
  ["history", /\b(?:added|removed|deleted|moved|introduced|changed|switched|dropped|rewritten|fixed) in #\d+\b/i],
  ["restatement", /\bnow (?:returns|reads|writes|throws|sets|calls|holds|takes|means|uses|runs|matches|does)\b/i],
  // The lookbehind exempts only a parenthetical directly attached to a
  // backticked identifier (see the header); a ref separated from the
  // identifier by other words, or carrying no identifier at all, still matches.
  ["provenance", /(?<!`[^`]*`\s*)\(\s*(?:issue\s+)?#\d+(?:\s*,\s*(?:issue\s+)?#\d+)*\s*\)/i],
  ["provenance", /\b(?:issue|see|closes|fixes|fixed in|part of) #\d+\b/i],
  ["provenance", /^#\d+\s*:/],
  ["provenance", /(?:\s|^)#\d+[.!?\s]*$/],
];

const DIRECTIVE = /^(?:#!|\/\/\s*(?:eslint-disable|@ts-|ts-ignore|ts-expect-error)\b|#\s*shellcheck\b|\*\s*(?:eslint-disable|@ts-))/i;

const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*(?:[|>&;#].*)?$/;

// The text a rule sees: the line without its comment marker, so `^#N:` means
// a comment that opens with an issue number rather than a shell marker.
function uncomment(lang, raw) {
  if (lang === "hash") return raw.replace(/^#+\s?/, "");
  return raw.replace(/^(?:\/\/|\/\*+|\*+)\s?/, "");
}

// Comment lines of `path`: [1-based line number, uncommented text, raw line].
function commentLines(path, text) {
  const lines = text.split("\n");
  const out = [];
  if (path.endsWith(".sh")) {
    let heredoc = null;
    lines.forEach((line, i) => {
      if (heredoc !== null) {
        if (line.trim() === heredoc) heredoc = null;
        return;
      }
      const raw = line.trim();
      if (raw.startsWith("#")) {
        out.push([i + 1, uncomment("hash", raw), raw]);
        return;
      }
      if (raw === "") return;
      const m = HEREDOC.exec(line);
      if (m) heredoc = m[2];
    });
    return out;
  }
  if (path.endsWith(".yml") || path.endsWith(".yaml")) {
    lines.forEach((line, i) => {
      const raw = line.trim();
      if (raw.startsWith("#")) out.push([i + 1, uncomment("hash", raw), raw]);
    });
    return out;
  }
  let inBlock = false;
  lines.forEach((line, i) => {
    const raw = line.trim();
    if (inBlock) {
      out.push([i + 1, uncomment("slash", raw), raw]);
      if (raw.includes("*/")) inBlock = false;
      return;
    }
    if (raw.startsWith("/*")) {
      out.push([i + 1, uncomment("slash", raw), raw]);
      if (!raw.includes("*/")) inBlock = true;
      return;
    }
    if (raw.startsWith("//")) {
      out.push([i + 1, uncomment("slash", raw), raw]);
      return;
    }
    let inString = null;
    for (let c = 0; c < line.length - 1; c++) {
      const char = line[c];
      if (inString === null) {
        if (char === '"' || char === "'" || char === '`') {
          inString = char;
        } else if (char === '/' && line[c + 1] === '/') {
          out.push([i + 1, line.slice(c + 2).trim(), raw]);
          break;
        }
      } else {
        if (char === '\\') c++;
        else if (char === inString) inString = null;
      }
    }
  });
  return out;
}

const problems = [];

try {
  if (!read("AGENTS.md").includes(POLICY_LEAD)) {
    problems.push(`AGENTS.md: the comment policy is missing — expected a bullet starting ${POLICY_LEAD}`);
  }
} catch {
  problems.push("AGENTS.md: unreadable — the comment policy must live there");
}

for (const file of AUDITED) {
  let text;
  try {
    text = read(file);
  } catch {
    problems.push(`${file}: listed as audited but not readable — update AUDITED`);
    continue;
  }
  for (const [n, line, raw] of commentLines(file, text)) {
    if (DIRECTIVE.test(raw)) continue;
    for (const [kind, re] of RULES) {
      if (re.test(line)) {
        problems.push(`${file}:${n}: ${kind}: ${line.slice(0, 100)}`);
        break;
      }
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`comment policy: ${p}`);
  process.exit(1);
}
console.log("comment policy: ok");
