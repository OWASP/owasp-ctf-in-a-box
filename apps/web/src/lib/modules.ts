// CTF module registry. Registration is deliberate: a new vertical is code —
// an entry here, and nothing else. There is no config-file namespace to
// declare one in; enablement is a runtime /admin setting on
// top of this list. See the kit's docs/modules.md for the full contract.
export type ModuleId = "secure-development" | "quiz" | "classic" | "ai";

/** Context handed to a module's home-page copy so it can interpolate live
 *  facts (target counts, app names) without importing them itself. */
export type HomeContext = {
  appCount: number;
  appList: string;
  topAppsList: string;
  totalChallenges: number;
};

/** A module's contribution to the landing page. Plain data + pure functions —
 *  no JSX — so the registry stays importable from server and client alike. */
export type ModuleHome = {
  /** Uppercase kicker rendered under the event name. */
  tagline: string;
  /** The hero paragraph for this module. */
  intro: (ctx: HomeContext) => string;
  /** Numbered how-it-works cards. */
  steps: (ctx: HomeContext) => { title: string; body: string }[];
  /** Optional CTA into the module's own route. */
  cta?: { href: string; label: string };
  /** Optional extra full-width section. */
  extra?: { kicker: string; heading: string; body: string };
};

// The three values the copy links into live in the dependency-free
// `module-urls.ts` leaf (#504 M10): the per-module defs need them, and a def
// importing them from HERE would close a cycle — and unlike `ModuleDef`, these
// are values, so that loop throws at init rather than merely looking untidy.
// Re-exported so the callers that already read them from this module —
// `site.ts`, the home page, the AI setup component — keep one import.
export { DOCS_URL, SCORING_BRANCH, SECURE_AGENT_PLAYBOOK_URL } from "@/lib/module-urls";

/** A run of contestant-facing copy that needs a little inline markup.
 *
 *  The registry holds copy, not JSX (it must stay importable either side of
 *  the server boundary), but some sentences genuinely emphasise a phrase or
 *  link out mid-clause — "patch the root cause" bonus notes, the Secure Agent
 *  Playbook link in the rules. Modelling those as SEGMENTS keeps the registry
 *  free of JSX while rendering byte-identically to the hand-written markup
 *  they replaced; `components/module-copy.tsx` is the one renderer. */
export type CopySegment =
  | string
  /** A phrase lifted out of the surrounding sentence (`text-zinc-200`). */
  | { em: string }
  /** A phrase that leads its bullet (`text-white`). */
  | { strong: string }
  /** An external link, opened in a new tab. */
  | { link: { href: string; label: string } }
  /** A link to another page of this site, client-side routed. */
  | { route: { href: string; label: string } }
  /** An inline literal — a branch name, a command, a file path. */
  | { code: string };

/** Either a plain sentence or a segmented one — see `CopySegment`. */
export type Copy = string | CopySegment[];

/** Live facts handed to a module's `/rules` copy. Same idea as `HomeContext`,
 *  minus the landing page's catalogue-derived numbers, which `/rules` has no
 *  reason to fetch. */
export type RulesContext = {
  appCount: number;
  appList: string;
};

/** Live facts for copy that also names the GitHub org contestants work in:
 *  `/faq`'s submission answer and `/terms`' scope statement both interpolate
 *  it. Passed IN rather than imported by the registry so a module's copy stays
 *  a pure function of its context. */
export type OrgContext = RulesContext & { githubOrg: string };

/** Live facts handed to a module's `/how-to-play` copy: the org context plus
 *  which worked-example variant applies (see `workedExampleVariant` in
 *  `@/lib/apps`). */
export type GuideContext = OrgContext & {
  exampleVariant: "juice-shop" | "generic";
};

/** Live facts handed to a module's `/faq` copy: the org context plus the
 *  organizer's CONFIGURED hint price.
 *
 *  Passed in rather than read here for the same reason `githubOrg` is — the
 *  registry's copy stays a pure function of its context — and passed in at all
 *  because `hintCost` is an /admin runtime setting in `[0, HINT_COST_MAX]`,
 *  not a constant. A FAQ hardcoding a literal "10 points" would misquote it
 *  for every organizer who moves the price, while `/challenges`, the reveal
 *  button and the challenge pages all show the real one. */
export type FaqContext = OrgContext & {
  /** `hintCost` as resolved for this request — `getHintNotice().cost`. */
  hintCost: number;
};

/** One numbered card in a guide's step list or worked example. */
export type GuideStep = { title: string; body: string; code?: string };

/** A module's contribution to `/how-to-play` — the long-form counterpart to
 *  `ModuleHome`.
 *
 *  Deliberately its OWN field rather than a reuse of `home.steps`: the two
 *  say different things at different lengths (the landing page's four short
 *  cards pitch the event; these five walk a contestant through their first
 *  submission, with a worked example, code blocks and caveats). Nothing is
 *  written twice — a string lives in `home` or in `guide`, never both. */
export type ModuleGuide = {
  /** The page's own lede, used verbatim when this module is the event's only
   *  guided one; a multi-module event falls back to the platform's. */
  lede: string;
  /** `<meta name="description">` copy for `/how-to-play`. Joined across
   *  modules, so keep it to a sentence. */
  metaDescription: string;
  /** The "the loop" callout: this module's play cycle, rendered as arrow-
   *  separated steps, plus the note under it. */
  loop?: { kicker: string; cycle: string[]; note: string };
  /** A callout above the numbered steps (secure-development's "Please use
   *  AI", which changes how you do step 4). */
  callout?: { kicker: string; body: Copy };
  /** How you play this module, start to finish. */
  steps: (ctx: GuideContext) => GuideStep[];
  /** An optional end-to-end worked example. `anchor` is the section's DOM id
   *  (`aria-labelledby`), authored here so two modules' examples can't
   *  collide on one page. */
  example?: (ctx: GuideContext) => {
    kicker: string;
    heading: string;
    anchor: string;
    lede: Copy;
    steps: GuideStep[];
    bonus?: { kicker: string; body: Copy };
  };
  /** "Good to know" bullets. Merged across modules into one list. */
  notes?: string[];
  /** The module's paragraph under the platform's "How scoring works". */
  scoring?: string;
  /** CTA into the module's own route, rendered alongside the platform's. */
  cta?: { href: string; label: string };
};

/** A module's contribution to `/rules`, bucketed by the section it belongs
 *  in. The platform owns the section headings and the genuinely event-wide
 *  bullets (teams, conduct, prizes, disputes); a module owns every bullet
 *  that names its own artifacts — targets, pull requests, patches, hints,
 *  questions — because those read as nonsense on an event not running it.
 *
 *  A function of `RulesContext` for the same reason `ModuleHome.intro` is:
 *  the scope rule interpolates the event's real target list. Server-only,
 *  therefore, and stripped from `ResolvedModule` like `home` and `guide`. */
export type ModuleRules = (ctx: RulesContext) => {
  /** Appended after the platform's team rules. */
  teams?: Copy[];
  /** The whole "Fair play" list: today every bullet in it names a module's
   *  own artifacts, so the platform contributes none. */
  fairPlay?: Copy[];
  /** Appended after the platform's conduct rules. */
  conduct?: Copy[];
  /** Prepended before the platform's prize and dispute rules. */
  scoring?: Copy[];
};

/** A module's contribution to `/faq`, bucketed by where it lands in the
 *  platform's own running order.
 *
 *  Buckets rather than one flat list because the platform's own questions —
 *  can I compete solo, is there a prize, where do I get help — are not all at
 *  one end: "Can I compete solo?" sits between a module's "do I need
 *  experience" and its "what do I need to bring", and the answer file reads
 *  wrong if the module's questions are all shunted to the top or the bottom.
 *
 *  Answers are `Copy`, not JSX, for the same reason every other block here is:
 *  the registry must stay importable either side of the server boundary.
 *  `/faq` renders them through `<ModuleCopy>`. */
export type ModuleFaq = (ctx: FaqContext) => {
  /** Opens the page, before the platform's "Can I compete solo?". */
  gettingStarted?: { q: string; a: Copy; id?: string }[];
  /** What a contestant needs on the day, after it. */
  prep?: { q: string; a: Copy; id?: string }[];
  /** The play loop: submitting, scoring, retrying, getting unstuck. */
  playing?: { q: string; a: Copy; id?: string }[];
};

/** A module's contribution to `/terms`, bucketed by section.
 *
 *  Unlike `/rules`, EVERY section here is module-owned, because every
 *  participation term this kit has ever written names the module's own
 *  artifacts: what you submit, where you may test, what a point is worth. The
 *  platform keeps only the two terms that hold on any event whatsoever (prizes
 *  and disputes) plus a fallback list per section for an event whose modules
 *  contribute none — a terms page with an empty "Scope of authorized testing"
 *  is worse than a generic one, since that section is the one that tells
 *  contestants what they are permitted to attack. */
export type ModuleTerms = (ctx: OrgContext) => {
  /** Who may take part and under which identity. */
  eligibility?: Copy[];
  /** What testing this event authorizes, and what it explicitly does not. */
  scope?: Copy[];
  /** What a contestant submits, and under what terms. */
  submissions?: Copy[];
  /** Prepended before the platform's prize and dispute terms. */
  scoring?: Copy[];
};

/** One step of a module's organizer-facing setup checklist.
 *
 *  `where` is the whole reason the field exists as data rather than prose:
 *  an organizer hunting for "the place I add questions" must be told whether
 *  that place is this panel or somewhere outside it (`ctf-setup.sh`, the
 *  GitHub org, `.env`) — the two failure modes the admin panel's own
 *  audit found were people looking in the wrong one.
 *
 *  `check` names a live count the panel already holds (its own list of
 *  items, or its category list) that PROVES the step done. It is a key, not
 *  a computed boolean, so the registry can say "questions exist" without
 *  knowing how to count them; the panel supplies the number, and shows
 *  "checking" until it has one rather than a false "none yet". A step the
 *  panel genuinely cannot verify — a fork provisioned, an App installed —
 *  carries no `check` and renders as a plain checklist item. Do not fake one. */
export type SetupStep = {
  title: string;
  body?: Copy;
  /** Done inside this admin panel, or outside it. */
  where: "panel" | "outside";
  check?: {
    /** Which count on the panel's inventory proves this step. */
    count: "items" | "categories";
    /** Plural noun for the count line ("3 questions"). */
    noun: string;
    /** Singular, when it is not `noun` minus an "s". */
    one?: string;
  };
};

/** The organizer-facing counterpart to `home`/`guide`: what a module's admin
 *  tab opens with. Answers, in this order, what contestants experience, what
 *  the organizer must do before the event (dependency order, with `where`
 *  on each step), what is safe to change mid-event and what is not, and where
 *  the long-form guide is.
 *
 *  A function of `OrgContext` for the same reason `faq`/`terms` are: the
 *  checklist for `secure-development` names the event's real targets and
 *  GitHub org. So it carries the same server-only contract — called in a
 *  Server Component (`getModuleSetup` in `@/lib/resolved-modules`), stripped
 *  from `ResolvedModule`, and only its plain-data RESULT
 *  (`ModuleSetupContent`) is handed to the admin shell. */
export type ModuleSetupContent = {
  /** 1. What contestants experience in this module, in a sentence or two. */
  experience: string;
  /** 2–3. The minimum to make the module playable, in dependency order. */
  steps: SetupStep[];
  /** 4. What may be changed while contestants are playing, and what may not. */
  midEvent: { safe: Copy[]; unsafe: Copy[] };
  /** 5. The module's section of the operations guide. */
  docs: { href: string; label: string };
};
export type ModuleSetup = (ctx: OrgContext) => ModuleSetupContent;

export type ModuleDef = {
  id: ModuleId;
  displayName: string;
  description: string;
  /** Nav entry, rendered iff the module is enabled (module contract §5.4).
   *  Omitted by a module that has no contestant route yet. */
  nav?: { href: string; label: string };
  /** Landing-page copy for this module, composed into `app/page.tsx` by the
   *  platform frame. Optional: a module with no `home` simply contributes
   *  nothing to the landing page, which is valid, not an error. Server code
   *  reaches it through `getModuleHome` — never off a ResolvedModule, which
   *  strips it so the object stays safe to hand to a Client Component. */
  home?: ModuleHome;
  /** Long-form `/how-to-play` copy for this module, composed into that page
   *  by the platform frame. Optional, like `home`, and reached the same way:
   *  `getModuleGuide` in `@/lib/resolved-modules`, never off a
   *  ResolvedModule — `steps`/`example` are functions. */
  guide?: ModuleGuide;
  /** This module's `/rules` bullets. Same server-only contract as `guide`:
   *  it is a function, so it never rides on a ResolvedModule. */
  rules?: ModuleRules;
  /** This module's `/faq` questions, and its `/terms` clauses. Same
   *  server-only contract again — both are functions of live event facts. */
  faq?: ModuleFaq;
  terms?: ModuleTerms;
  /** One line describing this module's own route, for the 404's directory of
   *  routes. The card's label and href come from `nav`; this is the sentence
   *  under them. A function, so it can name the live target list — and so it
   *  is stripped from ResolvedModule like the rest. */
  routeCard?: (ctx: RulesContext) => string;
  /** The organizer-facing setup checklist that opens this module's admin
   *  tab. A function (see `ModuleSetup`), so it is stripped from
   *  ResolvedModule like the contestant-facing blocks above and reached
   *  through `getModuleSetup`. */
  setup?: ModuleSetup;
  /** What `/leaderboard`'s empty state says, and where it points, while this
   *  module is the way onto the board. The platform frame owns the empty
   *  state's framing ("the board is wide open"); the module owns the sentence
   *  that says how to get on it, because "patch your first challenge" is
   *  nonsense on an event that has no challenges. The first enabled module
   *  with one wins, so registry order decides on a multi-module event.
   *
   *  Plain data, deliberately — unlike `home` it survives onto ResolvedModule
   *  (a Client Component renders it), which only holds because there is no
   *  function here to break the RSC boundary. Keep it that way. */
  emptyBoard?: { line: string; cta: { href: string; label: string } };
};

// Display metadata per registered module, one file per entry (#504 M10) —
// this literal was ~1230 lines, 71% of this file. Each def takes `ModuleDef`
// back as a TYPE import, so the edge into it is not a runtime one, and the
// URLs its copy links into come from `module-urls.ts` for the same reason.
import { AI_DEF } from "@/lib/module-defs/ai";
import { CLASSIC_DEF } from "@/lib/module-defs/classic";
import { QUIZ_DEF } from "@/lib/module-defs/quiz";
import { SECURE_DEVELOPMENT_DEF } from "@/lib/module-defs/secure-development";

// Registration is deliberate: an entry here is the whole declaration — there
// is no config file that can add one. Key ORDER is registry order:
// ALL_MODULE_IDS, ALL_MODULE_ROUTES and the nav all derive from this object's
// key order, so it must not be sorted or reshuffled.
const REGISTRY: Record<ModuleId, ModuleDef> = {
  "secure-development": SECURE_DEVELOPMENT_DEF,
  quiz: QUIZ_DEF,
  classic: CLASSIC_DEF,
  ai: AI_DEF,
};

/** A full `ModuleDef` for EVERY registered module — `REGISTRY` itself.
 *  Which targets secure-development runs is not part of a `ModuleDef`:
 *  it lives on the admin panel in
 *  `ctf:admin:settings.secureDevTargets` (see lib/secure-dev-targets.ts and
 *  lib/enabled-apps.ts), read per request rather than baked at build time. */
const MODULE_DEFS: Record<ModuleId, ModuleDef> = REGISTRY;

// There is deliberately no "enabled modules' routes" list here:
// proxy.ts gates ALL_MODULE_ROUTES below — the superset, needing no Redis
// read from middleware — and /gate computes its own destination from the
// live resolved list. A baked list would be a second answer to "which
// routes are live" that could drift from the runtime one.

/** EVERY route the registry knows about, enabled or not.
 *
 *  Exists because Next requires the proxy's `matcher` to be a static literal
 *  ("matcher values need to be constants so they can be statically analyzed at
 *  build-time. Dynamic values such as variables will be ignored" — the
 *  vendored proxy docs), so that list CANNOT be computed from this one. It is
 *  written out by hand there and asserted against this by proxy.test.ts, so
 *  registering a module with a route the proxy never sees fails a test instead
 *  of silently un-gating the new route. */
export const ALL_MODULE_ROUTES: readonly string[] = (Object.values(REGISTRY) as ModuleDef[]).flatMap((m) =>
  m.nav ? [m.nav.href] : [],
);

/** Every module id the registry knows about, enabled or not — the vocabulary
 *  a runtime enablement set is validated against. Derived from
 *  REGISTRY rather than restated, so registering a module cannot forget it. */
export const ALL_MODULE_IDS: readonly ModuleId[] = Object.keys(REGISTRY) as ModuleId[];

/** A registered module's def by id, enabled or not.
 *
 *  The registry accessors in `resolved-modules.ts` (`getModuleHome` and
 *  friends) go through this rather than searching the resolved/live list.
 *  Searching a filtered list meant a module enabled at runtime resolved to `undefined`
 *  for every one of them — it would get a route, a nav link and a tab, and
 *  then render with no landing section, no how-to-play steps, no rules, no FAQ
 *  and no terms. Enablement is the caller's question (they already iterate the
 *  resolved list); this answers "what does the registry say about this id". */
export function moduleDefById(id: ModuleId): ModuleDef | undefined {
  return MODULE_DEFS[id];
}

/** Narrows an arbitrary string to a registered module id. Used on the way IN
 *  from Redis: an id that is not in the registry has no route, no nav entry
 *  and no tab, so honouring one would enable something that cannot render. */
export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && (ALL_MODULE_IDS as readonly string[]).includes(value);
}

/** Organizer-authored, runtime overrides keyed by module id. Both fields are
 *  optional and an empty string means "no override" — see resolveModules. */
export type ModuleOverrides = Partial<Record<ModuleId, { title?: string; blurb?: string }>>;

/** Caps for organizer-authored per-module naming overrides (title/blurb).
 *  Defined here — not in `admin-store.ts`, which validates against them —
 *  because this module is client-safe and `admin-store.ts` is `server-only`;
 *  the admin panel's identity form (a Client Component) needs these numbers
 *  for its `maxLength` attributes and would break the client build if it
 *  imported them (or anything else) from admin-store by value. admin-store
 *  re-exports these two so it stays the single place server code looks for
 *  them. */
export const MODULE_TITLE_MAX = 60;
export const MODULE_BLURB_MAX = 200;

/** A module with its organizer-authored naming applied: identity only, and
 *  deliberately client-safe.
 *
 *  `displayName`/`description` are OMITTED rather than carried through: they
 *  are the registry DEFAULTS, and `title`/`blurb` are what a consumer must
 *  render. Keeping both on the same object made reading `.displayName` off a
 *  resolved module — silently ignoring the organizer's override — a plain
 *  property access with no type error. Dropping them turns that mistake into
 *  a compile failure.
 *
 *  The copy blocks — `home`, `guide`, `rules`, `faq`, `terms`, `routeCard`
 *  and `setup` — are OMITTED for a harder reason: `ModuleHome.intro`,
 *  `ModuleHome.steps`, `ModuleGuide.steps`, `ModuleGuide.example`,
 *  `routeCard`, and `ModuleRules`/`ModuleFaq`/`ModuleTerms`/`ModuleSetup`
 *  themselves are FUNCTIONS, and resolved modules are handed straight
 *  from Server Components to `"use client"` components (the admin panel, the
 *  leaderboard). React's flight serializer throws "Functions cannot be passed
 *  directly to Client Components" on any function-valued prop, so a resolved
 *  module carrying `home` would 500 those pages the moment a module defines
 *  one. Keeping identity-only here makes that structurally impossible instead
 *  of a trap for the next module to opt into landing-page copy. Server code
 *  that needs the home block reads it from the registry — see
 *  `getModuleHome` in `@/lib/resolved-modules`. */
export type ResolvedModule = Omit<
  ModuleDef,
  "displayName" | "description" | "home" | "guide" | "rules" | "faq" | "terms" | "routeCard" | "setup"
> & {
  /** What to render wherever the MODULE names itself: the organizer's
   *  override, or the registry `displayName`. Never empty. */
  title: string;
  blurb: string;
  /** The organizer's override alone — trimmed, or `undefined` when unset.
   *
   *  This exists because `title` cannot answer "did the organizer rename
   *  this?", and some surfaces have a per-surface default that is
   *  deliberately NOT the module's name. `secure-development`'s nav label is
   *  "Challenges" while its display name is "Secure Development": one names
   *  the module, the other describes the destination page. Rendering `title`
   *  there silently renamed the nav on every existing event with no override
   *  involved. The rule is: an explicit override replaces the module's name
   *  wherever it appears; with no override, the existing per-surface default
   *  stands unchanged. Surfaces with their own default read
   *  `titleOverride || <that default>`; surfaces that always showed the
   *  module's name keep reading `title`.
   *
   *  A string (or absent), so this stays safe to hand to a Client Component
   *  — see the note above about `home`. */
  titleOverride?: string;
};

/** The module defs this event is serving, in registry order. The order is
 *  the registry's — the one organizers and tests can predict, and toggling
 *  a module off and on lands it back in the same slot. */
function moduleDefsFor(enabled: ReadonlySet<ModuleId>): readonly ModuleDef[] {
  return ALL_MODULE_IDS.filter((id) => enabled.has(id)).map((id) => MODULE_DEFS[id]);
}

/** Merge registry defaults with organizer overrides. Pure — no I/O — so it is
 *  testable on its own and usable either side of the server boundary. An
 *  override for a module that isn't enabled has nothing to apply to and is
 *  simply absent from the result; an empty string is treated as unset so
 *  clearing a field in the admin UI restores the registry default.
 *
 *  `enabled` is the LIVE module set and is required — there is no baked
 *  set to fall back to. */
export function resolveModules(
  overrides: ModuleOverrides,
  enabled: ReadonlySet<ModuleId>,
): readonly ResolvedModule[] {
  const defs = moduleDefsFor(enabled);
  // Destructure the defaults OUT rather than spreading them through, so a
  // resolved module genuinely has no `displayName` to read by mistake — the
  // type and the runtime object agree. Every copy block — `home`, `guide`,
  // `rules`, `faq`, `terms`, `routeCard`, `setup` — goes the same way, and there it
  // is load-bearing rather than merely tidy: a type-level Omit alone would
  // leave the functions on the object, still crossing the RSC boundary and
  // still throwing. Stripping them here is what makes the result client-safe.
  // They are bound only to keep them out of `...rest` — being unused IS the
  // point, so the lint warning is silenced deliberately rather than worked
  // around by re-spreading and deleting.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return defs.map(({ displayName, description, home, guide, rules, faq, terms, routeCard, setup, ...rest }) => {
    const o = overrides[rest.id];
    // Computed once and carried through as `titleOverride`, so a consumer
    // with its own per-surface default (the nav label, /challenges' page
    // title) can tell "the organizer renamed this" from "the registry
    // default happens to be this string" — see ResolvedModule.
    const titleOverride = o?.title?.trim() || undefined;
    return {
      ...rest,
      titleOverride,
      title: titleOverride ?? displayName,
      blurb: o?.blurb?.trim() || description,
    };
  });
}
