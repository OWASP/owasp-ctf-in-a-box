- **Changed: changelog entries are fragments, not lines in `CHANGELOG.md`
  (#785).** A PR that changes shipped code adds one file,
  `changelog.d/<issue>-<slug>.md`, holding its entry, and the `changelog`
  check is satisfied only by a new fragment (editing `CHANGELOG.md` does not
  satisfy it). Open PRs stop conflicting on the `## Unreleased` block.
  `node scripts/changelog-assemble.mjs` folds the fragments into
  `CHANGELOG.md` at release.
