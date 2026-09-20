// The term list checks itself here.
//
// `secure-dev-terms.ts` is only worth anything if every entry in it actually
// names copy that exists. A term that matches nothing is not a safety net,
// it is decoration — and it fails silently, since the suites that use the
// list only ever assert ABSENCE, which a dead term satisfies trivially. Two
// had already rotted this way: `repository` names nothing on either page, and
// `repo's` could never fire because React escapes the apostrophe to
// `&#x27;`. An aggregate "more than half of them match" check did not notice
// either.
//
// So: render the pages that ARE supposed to carry the secure-development
// vocabulary, on the shipped event config, and require EVERY term and EVERY
// live pattern to match something in the combined markup. A term that stops
// matching fails here, loudly, instead of quietly weakening the quiz-only
// suites.
//
// The corpus is every page whose quiz-only counterpart asserts absence. It
// started as /how-to-play and /rules alone, which is how the app-name and
// repository vocabulary came to be missing from the list: the pages carrying
// it — the FAQ, the terms, the 404 — were outside both nets at once.
//
// The LATENT patterns are proven against `SECURE_DEV_SPECIMENS` instead; see
// the header note in secure-dev-terms.ts for why they are not required to
// match the shipped render.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  findSecureDevLeaks,
  normalizeHtml,
  SECURE_DEV_LATENT_PATTERNS,
  SECURE_DEV_LIVE_PATTERNS,
  SECURE_DEV_SPECIMENS,
  SECURE_DEV_TERMS,
} from "./secure-dev-terms";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/enabled-modules", () => import("@/test/enabled-modules-baked"));
// The org vocabulary this file's own "fork org" case (below) pins now comes
// from GITHUB_ORG via bootstrap-env, not the (now-dead) event.yaml bake — the
// shipped config's org, kept so the corpus still carries that vocabulary.
vi.mock("@/lib/bootstrap-env", () => ({ getGithubOrg: () => "OWASP-CTF" }));
vi.mock("@/lib/admin-store", () => ({
  // `getResolvedModules` falls back to the baked shim's ALL-module
  // `defaultModuleIds` unless this names the shipped config's own set.
  getAdminSettings: async () => ({ moduleOverrides: {}, enabledModuleIds: ["secure-development"] }),
}));

import HowToPlay from "@/app/(site)/how-to-play/page";
import Rules from "@/app/(site)/rules/page";
import Faq from "@/app/(site)/faq/page";
import Terms from "@/app/(site)/terms/page";
import NotFound from "@/app/not-found";

// All of them together: the list is shared, and a term may legitimately live
// on only one page (hint costs are a rules bullet; the worked example's shell
// commands are the guide's; the target names are the 404's route card).
const markup = [
  await HowToPlay().then(renderToStaticMarkup),
  await Rules().then(renderToStaticMarkup),
  renderToStaticMarkup(await Faq()),
  renderToStaticMarkup(await Terms()),
  await NotFound().then(renderToStaticMarkup),
].join("\n");
const normalized = normalizeHtml(markup);

describe("the secure-development term list", () => {
  it.each(SECURE_DEV_TERMS)(
    "%j matches the secure-development render, so asserting its absence means something",
    (term) => {
      expect(normalized).toContain(term);
    },
  );

  it.each(SECURE_DEV_LIVE_PATTERNS)(
    "%s matches the secure-development render, so asserting its absence means something",
    (pattern) => {
      expect(markup).toMatch(pattern);
    },
  );

  it.each(SECURE_DEV_LATENT_PATTERNS)(
    "%s fires on copy it names, so asserting its absence means something",
    (pattern) => {
      expect(SECURE_DEV_SPECIMENS.some((s) => pattern.test(s))).toBe(true);
    },
  );

  // The mutation that motivated the latent half. Every one of its words is
  // secure-development vocabulary and none of them were in the list.
  it("catches the whole of a sentence written in the workflow's own words", () => {
    expect(findSecureDevLeaks(SECURE_DEV_SPECIMENS[0]).length).toBeGreaterThan(4);
    for (const specimen of SECURE_DEV_SPECIMENS) {
      expect(findSecureDevLeaks(specimen)).not.toEqual([]);
    }
  });

  // The `target` pattern is the one with a deliberate exclusion in it, and
  // the exclusion is what makes the term usable at all. Pin both halves:
  // prose about targets is caught, the `target="_blank"` on every external
  // link is not.
  it("catches prose about targets without firing on target= attributes", () => {
    const [targets] = SECURE_DEV_LIVE_PATTERNS.filter((p) => p.source.includes("target"));
    expect("Browse the targets, then point your AI agent at a target.").toMatch(targets);
    expect('<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>').not.toMatch(
      targets,
    );
    // The second exclusion: the code of conduct's homonym, where "the target"
    // is the person a behaviour is aimed at. Narrowed to that phrasing and no
    // further — "the target's repo" and "the target app" still fire, so the
    // exclusion cannot be widened into a hole without failing here.
    expect("You do not need to be the target to report something.").not.toMatch(targets);
    expect("Fork the target's repo, then patch the target app.").toMatch(targets);
    expect("Point it at the target and read the source.").toMatch(targets);
  });

  // Same shape, for the two narrowings added with the app names: "repo" must
  // not fire on "Report", and "commit" must not fire on the platform's own
  // "what taking part commits you to".
  it("catches the bare nouns without firing on the words that contain them", () => {
    const [repo] = SECURE_DEV_LIVE_PATTERNS.filter((p) => p.source.startsWith("\\brepos"));
    expect("Fork the repo and open a PR.").toMatch(repo);
    expect("Report it to an organizer instead of exploiting it.").not.toMatch(repo);

    const [commit] = SECURE_DEV_LIVE_PATTERNS.filter((p) => p.source.startsWith("\\bcommits"));
    expect("Write the commit message like a real security fix.").toMatch(commit);
    expect("What taking part in this competition commits you to.").not.toMatch(commit);
  });

  // The org shape in the guide's commands and prose must fire, and the
  // exclusion must be exactly "preceded by a slash" and no wider. The kit's
  // own two links used to be what pinned that exclusion — they carried the
  // bare slug while they were `dcotelo.github.io/owasp-ctf/` and
  // `github.com/dcotelo/owasp-ctf` — but the move to
  // `OWASP/owasp-ctf-in-a-box` ended the collision: neither URL contains the
  // slug followed by a slash any more, so asserting on them would pass
  // whatever the lookbehind did. The fork org's own GitHub URL is the witness
  // that remains — same slug, as a path segment, must not fire.
  it("catches the fork org without firing on a URL path segment", () => {
    const [org] = SECURE_DEV_LIVE_PATTERNS.filter((p) => p.source.includes("owasp-ctf"));
    expect("gh repo fork OWASP-CTF/juice-shop --clone").toMatch(org);
    expect("The base repo is OWASP-CTF/juice-shop and the base branch is main.").toMatch(org);
    expect("Fork it under OWASP-CTF/&lt;target&gt; on GitHub.").toMatch(org);
    expect('<a href="https://github.com/OWASP-CTF/juice-shop">the fork</a>').not.toMatch(org);
    expect("This event runs on OWASP CTF: one machine, one free GitHub org.").not.toMatch(org);
  });
});

// issue #379: every provisioned target's default (and only scoring) branch is
// `ctf` — ctf-setup.sh's `ctf-branch` step creates it and `drop-old` deletes
// `master`/`main` — but the How to Play worked example, the FAQ, and Terms
// all told contestants to open their PR against `main`, which no longer
// exists on any provisioned repo.
describe("the scoring branch is ctf, not main", () => {
  it("the worked example's gh CLI commands target --base ctf, never --base main", () => {
    expect(markup).toContain("--base ctf");
    expect(markup).not.toContain("--base main");
  });

  it("no page tells a contestant the base/scoring branch is main", () => {
    expect(markup).not.toContain("base branch is main");
    expect(markup).not.toContain("repo's main branch");
    expect(markup).not.toContain("target repository's main branch");
  });

  // The two "score recorded" promises (How to Play's worked examples) must
  // name the ctf-score.yml workflow's ACTUAL heading, not an invented one.
  it("the score-comment promise matches the workflow's real heading", () => {
    expect(markup).toContain("CTF Patch Score");
    expect(markup).not.toContain("Score recorded");
  });
});
