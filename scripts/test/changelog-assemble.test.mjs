import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'changelog-assemble.mjs');
const BASE = '# Changelog\n\n## Unreleased\n\n- **Added: old (#1).** first.\n- **Fixed: older (#2).** second.\n\n## v0.1.0\n\n- an old entry\n';

function fixture(changelog = BASE, fragments = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cl-assemble-'));
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  mkdirSync(join(root, 'changelog.d'));
  writeFileSync(join(root, 'changelog.d', 'README.md'), '# fragments\n');
  for (const [n, c] of Object.entries(fragments)) writeFileSync(join(root, 'changelog.d', n), c);
  return root;
}

function run(root, ...args) {
  return spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
}

test('fragments land after existing entries, numeric order, files removed, README kept', () => {
  const root = fixture(BASE, { '12-a.md': '- **Added: a (#12).** A.\n', '3-b.md': '- **Fixed: b (#3).** B.\n' });
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  assert.equal(
    out,
    '# Changelog\n\n## Unreleased\n\n- **Added: old (#1).** first.\n- **Fixed: older (#2).** second.\n' +
      '- **Fixed: b (#3).** B.\n- **Added: a (#12).** A.\n\n## v0.1.0\n\n- an old entry\n',
  );
  assert.equal(existsSync(join(root, 'changelog.d', '12-a.md')), false);
  assert.equal(existsSync(join(root, 'changelog.d', '3-b.md')), false);
  assert.equal(existsSync(join(root, 'changelog.d', 'README.md')), true);
});

test('--dry-run changes nothing', () => {
  const root = fixture(BASE, { '3-b.md': '- **Fixed: b (#3).** B.\n' });
  const r = run(root, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), BASE);
  assert.equal(existsSync(join(root, 'changelog.d', '3-b.md')), true);
});

test('a missing Unreleased heading fails and leaves fragments alone', () => {
  const root = fixture('# Changelog\n\n## v0.1.0\n\n- x\n', { '3-b.md': '- b\n' });
  const r = run(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unreleased/);
  assert.equal(existsSync(join(root, 'changelog.d', '3-b.md')), true);
});

test('a fragment not starting with "- " fails', () => {
  const root = fixture(BASE, { '3-b.md': 'not a bullet\n' });
  const r = run(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /3-b\.md/);
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), BASE);
});

test('an empty fragment fails', () => {
  const root = fixture(BASE, { '3-b.md': '\n' });
  const r = run(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty/);
});

test('an empty Unreleased block and a last-section Unreleased both work', () => {
  const root = fixture('# Changelog\n\n## Unreleased\n', { '3-b.md': '- b\n' });
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\n## Unreleased\n\n- b\n');
});

test('the script runs under plain node with no fragments', () => {
  const root = fixture();
  assert.equal(execFileSync('node', [SCRIPT, '--root', root], { encoding: 'utf8' }).includes('added 0'), true);
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), BASE);
});
