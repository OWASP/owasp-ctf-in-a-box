#!/usr/bin/env node
// Two kinds of documentation drift that no build notices (issue #501):
//
// 1. docs/decisions.md's ADR index. Every `## ADR N.` heading needs exactly one
//    index entry whose anchor is that heading's generated id, every index
//    entry needs a heading, and every in-page `(#adr-…)` link has to land on
//    one. A heading must be ONE line: a wrapped `## ADR` heading takes only
//    its first line as the title, so the anchor silently loses the rest (ADR
//    57's did). The index had skipped 54, 57 and 58 without anyone noticing,
//    because the site build and the link check both ignore fragments.
//
// 2. The shell commands CI runs. Every path the `shell` job in ci.yml hands
//    to `shellcheck` or `bats` must also appear in the three places that tell
//    a human what to run locally: the Makefile, AGENTS.md and CONTRIBUTING.md.
//    The AWS deploy.sh and its bats suite were in CI and in none of the three.
//
// 3. The Node version. `.nvmrc` is what a contributor's `nvm use` picks, and
//    every `node-version:` in a workflow must be that same major — a suite
//    once passed on a newer local Node and failed on CI's 22 (#256).
//
// Usage: node scripts/check-docs-drift.mjs [repo-root]
// Exits 1 naming every problem, 0 with "docs drift: ok".
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(fileURLToPath(import.meta.url), "..", ".."));
const read = (rel) => readFileSync(join(root, rel), "utf8");
const problems = [];

// GitHub's heading-id rule, which the index anchors follow: lowercase, drop
// everything but letters, marks, digits, connector punctuation (`_`), hyphens
// and spaces, then each space becomes a hyphen (so " — " becomes "--").
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

// --- 1. the ADR index -------------------------------------------------------
{
  const lines = read("docs/decisions.md").split("\n");
  const headings = new Map(); // number -> anchor
  lines.forEach((line, i) => {
    const m = /^## ADR (\d+)\. (.+)$/.exec(line);
    if (!m) return;
    const n = Number(m[1]);
    if (headings.has(n)) problems.push(`docs/decisions.md:${i + 1}: a second "## ADR ${n}." heading`);
    headings.set(n, slug(`ADR ${n}. ${m[2]}`));
    const next = lines[i + 1] ?? "";
    if (next.trim() !== "") {
      problems.push(`docs/decisions.md:${i + 1}: the ADR ${n} heading wraps onto the next line — keep it on one line, or its anchor loses everything after the break`);
    }
  });

  const firstHeading = lines.findIndex((l) => /^## ADR \d+\. /.test(l));
  const indexLines = firstHeading === -1 ? lines : lines.slice(0, firstHeading);
  const indexed = new Map(); // number -> anchors
  indexLines.forEach((line, i) => {
    const m = /^- \[ADR (\d+) — .*\]\(#([^)\s]+)\)\s*$/.exec(line);
    if (!m) return;
    const n = Number(m[1]);
    if (!indexed.has(n)) indexed.set(n, []);
    indexed.get(n).push({ anchor: m[2], line: i + 1 });
  });

  for (const [n, anchor] of headings) {
    const entries = indexed.get(n) ?? [];
    if (entries.length === 0) {
      problems.push(`docs/decisions.md: ADR ${n} has no entry in the index (want #${anchor})`);
      continue;
    }
    if (entries.length > 1) problems.push(`docs/decisions.md: ADR ${n} is in the index ${entries.length} times`);
    for (const e of entries) {
      if (e.anchor !== anchor) {
        problems.push(`docs/decisions.md:${e.line}: the ADR ${n} index entry points at #${e.anchor}, but the heading's anchor is #${anchor}`);
      }
    }
  }
  for (const [n, entries] of indexed) {
    if (!headings.has(n)) problems.push(`docs/decisions.md:${entries[0].line}: the index lists ADR ${n}, which has no "## ADR ${n}." heading`);
  }

  const anchors = new Set(headings.values());
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\]\(#(adr-[^)\s]+)\)/g)) {
      if (!anchors.has(m[1])) problems.push(`docs/decisions.md:${i + 1}: link to #${m[1]}, which no ADR heading generates`);
    }
  });
  if (headings.size === 0) problems.push("docs/decisions.md: no `## ADR N.` headings found — the parser no longer matches the file");
}

// --- 2. CI's shell job, mirrored in the local instructions -----------------
{
  const ci = read(".github/workflows/ci.yml").split("\n");
  const start = ci.findIndex((l) => /^ {2}shell:\s*$/.test(l));
  const wanted = new Set();
  if (start === -1) {
    problems.push(".github/workflows/ci.yml: no `shell:` job found — the parser no longer matches the file");
  } else {
    for (let i = start + 1; i < ci.length && !/^ {2}\S/.test(ci[i]); i++) {
      // `- run:` for a bare step, plain `run:` under a named one (#512 review).
      const m = /^\s+(?:- )?run: (shellcheck|bats) (.+)$/.exec(ci[i]);
      if (!m) continue;
      // Paths are the tokens with a slash; flags and their values have none.
      for (const tok of m[2].trim().split(/\s+/)) if (tok.includes("/")) wanted.add(tok);
    }
    if (wanted.size === 0) problems.push(".github/workflows/ci.yml: the shell job runs no shellcheck/bats paths — the parser no longer matches the file");
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const file of ["Makefile", "AGENTS.md", "CONTRIBUTING.md"]) {
    const text = read(file);
    for (const path of wanted) {
      const re = new RegExp(`(^|[\\s\`])${esc(path)}($|[\\s\`\\\\;&)])`, "m");
      if (!re.test(text)) problems.push(`${file}: CI's shell job runs \`${path}\`, which ${file} never mentions`);
    }
  }
}

// --- 3. .nvmrc agrees with every workflow's node-version -------------------
{
  if (!existsSync(join(root, ".nvmrc"))) {
    problems.push(".nvmrc: missing — it pins the Node major CI runs");
  } else {
    const pinned = read(".nvmrc").trim();
    for (const f of readdirSync(join(root, ".github/workflows")).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      read(`.github/workflows/${f}`).split("\n").forEach((line, i) => {
        const m = /node-version:\s*['"]?([^'",}\s]+)/.exec(line);
        if (m && m[1] !== pinned) {
          problems.push(`.github/workflows/${f}:${i + 1}: node-version ${m[1]}, but .nvmrc pins ${pinned}`);
        }
      });
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`docs drift: ${p}`);
  process.exit(1);
}
console.log("docs drift: ok");
