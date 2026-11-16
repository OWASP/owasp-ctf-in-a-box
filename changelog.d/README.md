# Changelog fragments

A PR that changes shipped code adds its changelog entry as a fragment here,
not as a line in `CHANGELOG.md`. Every PR appending to the same
`## Unreleased` block made every open PR conflict with every merge; one new
file per PR cannot conflict.

## Naming

One Markdown file per PR, `<issue>-<slug>.md`, directly in this directory:

```
changelog.d/785-changelog-fragments.md
```

`<issue>` is the number of the issue the PR closes; `<slug>` is a few
lowercase words. This `README.md` is never a fragment.

## Format

The content is exactly the bullet entry (or entries) that would go in
`CHANGELOG.md`:

```
- **Kind: summary (#N).** Prose that tells an organizer what changed and
  what, if anything, they must do.
```

- `Kind` is one of `Added`, `Changed`, `Fixed`, `Removed`, `Security`.
  Put a **Breaking** note in the prose of the entry when an organizer has to
  act on an upgrade.
- Write for an organizer who runs the box, in the present tense, and say what
  they will see and do. History and review chatter belong in the commit and
  the PR.
- Keep each entry to one bullet that starts with `- `; indent continuation
  lines by two spaces.

## Checking

`scripts/check-changelog.sh origin/main HEAD` is what the `changelog`
workflow runs. A PR that changes `apps/`, `sync/`, `scorer/`, `setup/` or
`deploy/` passes by adding a new fragment here. Editing `CHANGELOG.md` does
not count. A maintainer can apply the `no-changelog` label for an internal
change with nothing to tell an organizer.

## At release

`node scripts/changelog-assemble.mjs` appends every fragment to the end of
the `## Unreleased` block in `CHANGELOG.md` (ordered by issue number, then
file name) and deletes the fragment files. `--dry-run` shows what it would
do without changing anything. The release then renames `## Unreleased` to the
version heading.
