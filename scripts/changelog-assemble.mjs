#!/usr/bin/env node
// Folds the changelog fragments in changelog.d/ into CHANGELOG.md at release.
//
// Usage: node scripts/changelog-assemble.mjs [--dry-run] [--root <dir>]
//
// Every changelog.d/*.md except README.md is appended, in order (numeric by
// the leading issue number, then by filename), to the END of the existing
// `## Unreleased` block, and the fragment files are then deleted. Entries
// already under `## Unreleased` stay where they are. Renaming `## Unreleased`
// to the version heading is a separate release step that runs after this one.
//
// Fails before touching anything when there is no `## Unreleased` heading,
// when a fragment is empty, or when a fragment does not start with `- `.
// --dry-run prints what would happen and changes nothing. --root names the
// directory holding CHANGELOG.md and changelog.d/ (default: the repo root).
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function orderFragments(names) {
  const num = (n) => {
    const m = /^(\d+)/.exec(n);
    return m ? Number(m[1]) : Infinity;
  };
  return [...names].sort((a, b) => num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0));
}

export function insertEntries(changelog, entries) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => /^## Unreleased\s*$/.test(l));
  if (start === -1) throw new Error("CHANGELOG.md has no '## Unreleased' heading");
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  let tail = end;
  while (tail > start + 1 && lines[tail - 1].trim() === '') tail--;
  const before = lines.slice(0, tail);
  const after = lines.slice(end);
  const middle = [];
  if (tail === start + 1) middle.push('');
  middle.push(...entries.flatMap((e) => e.split('\n')));
  middle.push('');
  return [...before, ...middle, ...after].join('\n');
}

export function assemble(root, { dryRun = false } = {}) {
  const dir = join(root, 'changelog.d');
  const file = join(root, 'CHANGELOG.md');
  const names = existsSync(dir)
    ? orderFragments(readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md'))
    : [];
  const entries = names.map((n) => {
    const text = readFileSync(join(dir, n), 'utf8').trim();
    if (text === '') throw new Error(`changelog.d/${n} is empty`);
    if (!text.startsWith('- ')) throw new Error(`changelog.d/${n} must start with '- ' (a bullet entry)`);
    return text;
  });
  const out = insertEntries(readFileSync(file, 'utf8'), entries);
  if (!dryRun) {
    writeFileSync(file, out);
    for (const n of names) unlinkSync(join(dir, n));
  }
  return names;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const i = args.indexOf('--root');
  const root = i !== -1 ? resolve(args[i + 1] ?? '') : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const names = assemble(root, { dryRun });
    const verb = dryRun ? 'would add' : 'added';
    console.log(`changelog-assemble: ${verb} ${names.length} fragment(s) to '## Unreleased'${names.length ? ': ' + names.join(', ') : ''}`);
  } catch (e) {
    console.error(`changelog-assemble: ${e.message}`);
    process.exit(1);
  }
}
