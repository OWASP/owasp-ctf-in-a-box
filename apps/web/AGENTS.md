# apps/web

This app is vendored into the OWASP CTF in a Box kit, and the kit's operating
manual is [`../../AGENTS.md`](../../AGENTS.md) — read it first. It has the
build/test commands (`corepack pnpm`, the grading-Lua suites against a real
Redis, the `/`-is-never-prerendered assertion), the CI gates, and the failure
modes this repo has already hit; nothing here repeats them. Two files next to
this one matter for app work: `VENDORED.md` records the delta from upstream
`OWASP-CTF/ctf-owasp-org` (what was stripped and why), and `DESIGN_SYSTEM.md`
is the palette and token authority.

The block below is Next.js's own. `next dev` writes and refreshes it when it
detects an agent; keep it, and commit the refresh when a Next upgrade changes
its text, or every `next dev` re-dirties the tree.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
