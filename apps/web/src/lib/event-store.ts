import "server-only";
import { exportBundle as exportClassic, clearChallenges, importBundle as importClassic } from "@/lib/classic-store";
import { exportBundle as exportQuiz, clearQuestions, importBundle as importQuiz } from "@/lib/quiz-store";
import { exportBundle as exportAi, clearAiChallenges, importBundle as importAi } from "@/lib/ai-store";
import {
  exportBundle as exportSponsors,
  importBundle as importSponsors,
  validateBundleLogos,
} from "@/lib/sponsors-store";
import { effectivePaused, getAdminSettings, resetEvent, updateAdminSettings, type SettingsPatch } from "@/lib/admin-store";
import { resolveSite } from "@/lib/site";
import { EVENT_BUNDLE_VERSION, EVENT_POLICY_FIELDS, type EventBundle, type EventPolicySettings } from "@/lib/event-io";
import { isModuleId, type ModuleId, type ModuleOverrides } from "@/lib/modules";
import { defaultEnabledModules, secureDevAvailable } from "@/lib/module-defaults";
import { checkSecureDevTargets, DEFAULT_SECURE_DEV_TARGETS } from "@/lib/secure-dev-targets";

const SD_WARNING =
  "Secure Development is enabled — its content (target repos, forks, rubrics) is not in the box and is NOT included in this bundle.";
const LIVE_WARNING = "This event is live — do not publish this bundle while contestants can still play.";

/** Assembles a whole-EVENT archive bundle for export: event metadata + policy
 *  settings + each enabled content module's own bundle. This is an
 *  ALLOWLIST, never a scan — the only sources it ever reads are the content
 *  modules' own `exportBundle()` (which themselves only read their own
 *  challenge/question definitions, never solves/attempts), the
 *  `EVENT_POLICY_FIELDS`-picked subset of `getAdminSettings()`, and the
 *  runtime identity fields (`name`, `theme`, `dates`, `location`,
 *  `ctfStartsAt`) resolved via `resolveSite` over that SAME settings read
 *  (see below — no second HGETALL, no fail-open in an export). No
 *  `ctf:user:*`/
 *  `ctf:team:*`/solve/attempt/hint/audit key is ever touched here.
 *
 *  `bundle.event` deliberately omits `contactEmail` and `discordUrl` even
 *  though both are runtime settings now (issue #386) — they are organizer
 *  PII: a private inbox and an invite link, neither needed to replay the
 *  event, and not safe to hand out in a bundle an organizer might publish or
 *  share. `dates`/`ctfStartsAt` are informational-only: a snapshot of what
 *  `resolveSite` derived from the scoring schedule AT EXPORT TIME, not a
 *  portable setting — the schedule itself (`scoringStartsAt`/`EndsAt`) is
 *  excluded from `bundle.settings` below, same as every other run-state
 *  field, so a re-import never restores this event's actual dates.
 *  `bundle.settings` deliberately omits every schedule/run field
 *  (`scoringStartsAt`/`EndsAt`, `registrationStartsAt`/`EndsAt`, `paused`,
 *  `updatedBy`, `updatedAt`) — those are per-EVENT-RUN state, not portable
 *  policy (see event-io.ts's header). */
export async function exportEventBundle(now: Date = new Date()): Promise<{ bundle: EventBundle; warnings: string[] }> {
  const settings = await getAdminSettings();
  // resolveSite over the SAME settings read, not a second getSite() call: a
  // Redis blip between two independent reads could otherwise write an archive
  // whose event.name is the fail-open default while bundle.settings came from
  // the good getAdminSettings() read that already succeeded (getAdminSettings
  // throws on failure; getSite() fails open to null instead). The schedule
  // fields feeding `dates`/`ctfStartsAt` come off this SAME `settings`, too.
  const site = resolveSite(settings.eventIdentity, {
    scoringStartsAt: settings.scoringStartsAt,
    scoringEndsAt: settings.scoringEndsAt,
  });
  const warnings: string[] = [];

  // Narrow out secure-development BEFORE `isEnabled`/the bundle write, same
  // rule as `getEnabledModuleIds` (CodeRabbit round 1 finding F): a stored
  // set can carry it forward from when this deployment had a scorer image
  // (admin-store's carry-forward rule), but an unscoreable board is never
  // reported as live in an export — no "not archivable" warning for it, and
  // it doesn't ride along in `bundle.settings.enabledModuleIds` for a re-import
  // to reconcile away later.
  const enabledModuleIds = (settings.enabledModuleIds ?? defaultEnabledModules(process.env)).filter(
    (id) => id !== "secure-development" || secureDevAvailable(process.env),
  );
  const isEnabled = (id: string) => enabledModuleIds.includes(id as (typeof enabledModuleIds)[number]);

  if (isEnabled("secure-development")) {
    warnings.push(SD_WARNING);
  }
  if (!effectivePaused(settings, now.getTime())) {
    warnings.push(LIVE_WARNING);
  }

  const policySettings: EventPolicySettings = {};
  for (const field of EVENT_POLICY_FIELDS) {
    const value = (settings as unknown as Record<string, unknown>)[field];
    // Omit a field that is unset (`null` — every scalar policy field's "no
    // override" value on ResolvedAdminSettings — or `undefined`) rather than
    // writing it out as `null`. A newer field (e.g. `aiCooldownSec`) that the
    // organizer never touched must not appear as a key at all, or this
    // export fails to import into a box built before that field existed:
    // event-io.ts's parser rejects any settings key outside its own
    // EVENT_POLICY_FIELDS allowlist, and an older box's allowlist doesn't
    // have it. Semantically identical on import either way — buildPolicyPatch
    // below already skips a null (or absent) field rather than forwarding it
    // to updateAdminSettings, so dropping it here changes nothing about what
    // a re-import applies, only whether an old box can parse the bundle at
    // all.
    if (value === null || value === undefined) continue;
    policySettings[field] = value;
  }
  // Overwrite with the RESOLVED module set (the same value `isEnabled` above
  // decides inclusion from), never the raw `settings.enabledModuleIds` the
  // loop just copied. That raw value is `undefined` whenever there is no
  // runtime override (the common case), and JSON.stringify drops an
  // `undefined` key entirely — silently losing both the source event's
  // effective module selection on replay AND import's ability to report a
  // Secure-Development module as `skipped` (its reconciliation only fires
  // off a concrete array).
  policySettings.enabledModuleIds = enabledModuleIds;
  // Same reasoning as `enabledModuleIds` immediately above: the generic loop
  // would have skipped this field entirely on a fresh box (`null` — nothing
  // stored), but a re-import of that export should still apply the SAME
  // resolved list every request reads today (`lib/enabled-apps.ts`'s
  // `getSecureDevTargets`), not silently omit the field. No second Redis
  // read — `settings` here is the same `getAdminSettings()` call already in
  // hand, exactly what `getSecureDevTargets` itself resolves over.
  policySettings.secureDevTargets = settings.secureDevTargets ?? DEFAULT_SECURE_DEV_TARGETS;

  const bundle: EventBundle = {
    version: EVENT_BUNDLE_VERSION,
    kind: "archive",
    event: {
      name: site.name,
      theme: site.theme,
      dates: site.dates,
      location: site.location,
      ctfStartsAt: site.ctfStartsAt,
    },
    settings: policySettings,
    ...(isEnabled("classic") ? { classic: await exportClassic() } : {}),
    ...(isEnabled("quiz") ? { quiz: await exportQuiz() } : {}),
    // #250: the ai catalogue rides along like the other two. Its own
    // `exportBundle` reads challenges, flags, hints, signing keys and
    // categories — never `ctf:ai:launchkey`, which is module identity.
    ...(isEnabled("ai") ? { ai: await exportAi() } : {}),
  };

  // Sponsors (#405) are a PLATFORM feature, not a module — there is no
  // `isEnabled` gate for them. `exportBundle` itself returns null on an
  // empty sponsor list, which is what actually decides whether this field
  // appears; a box with no sponsors configured ships an archive with no
  // `sponsors` key at all, same "render iff non-empty" rule the public
  // surfaces follow.
  const sponsorsBundle = await exportSponsors();
  if (sponsorsBundle) bundle.sponsors = sponsorsBundle;

  return { bundle, warnings };
}

/** Thrown by `importEventBundle`'s live guard. Maps to a 409 at the route via
 *  `instanceof` — never caught here, and never wrapped in a generic Error, so
 *  that mapping stays reliable. */
export class EventLiveError extends Error {}

export type EventImportSummary = {
  classic?: { created: number; updated: number };
  quiz?: { created: number; updated: number };
  ai?: { created: number; updated: number };
  /** No `updated` — sponsors import is a full replace into an
   *  already-cleared store (see `importEventBundle`'s sponsors branch), so
   *  every row is a create. */
  sponsors?: { created: number };
};

/** Replace-all import of a whole-EVENT archive bundle. Destructive: it wipes
 *  run state (`resetEvent`) and then REPLACES the box's content. All three
 *  archivable content stores (classic, quiz, ai) are cleared unconditionally
 *  — not only the ones present in the bundle — and only then is each section
 *  actually present in the bundle imported (clear-all, then import-present
 *  — never the reverse, or a stale challenge the bundle doesn't carry would
 *  survive the "replace"). The ai clear (`clearAiChallenges`) deliberately
 *  leaves `ctf:ai:launchkey` alone: rotating the module's published launch
 *  key on an import would break every deployed external verifier (#250,
 *  ADR 53). This is "replace-all into a box to replay THIS
 *  event": a quiz-only archive must leave the box with NO classic content,
 *  not the target's pre-existing classic content still sitting there ready
 *  to resurface if classic is later re-enabled. A module absent from the
 *  bundle ends up cleared but not re-imported — empty, matching the source.
 *  Refuses outright on a live event (see `EventLiveError`) — this must never
 *  run while contestants can still play.
 *
 *  Only `EVENT_POLICY_FIELDS` keys present in `bundle.settings` are applied
 *  to admin settings; schedule/run fields (`paused`, `scoringStartsAt`, etc.)
 *  are never in that allowlist (see event-io.ts's header) and so can never
 *  leak into the patch. `bundle.event.name` (always present) and its optional
 *  `theme`/`location` are merged into that SAME patch — see below. Secure
 *  Development content is outside what a bundle can carry at all — that is
 *  reported back in `skipped` rather than silently dropped.
 *
 *  Fail-fast ordering: the settings patch is built and applied FIRST, right
 *  after the live-guard and before anything destructive. `updateAdminSettings`
 *  VALIDATES the patch and throws `AdminValidationError` on a bad one (e.g. an
 *  out-of-range `hintCost`/`teamMaxMembers`, or any other malformed scalar
 *  field — `enabledModuleIds` itself is already reconciled against this
 *  deployment's availability below, so it can't trigger that particular
 *  refusal) — applying it before `resetEvent`/clear/import means a
 *  malformed bundle is rejected with NOTHING destructive done yet, instead of
 *  failing after the board has already been wiped and half-replaced. The
 *  identity fields ride the same patch and so get the same guarantee.
 *  `resetEvent` is safe to run after: it keeps `ctf:admin:settings` (see its
 *  own doc comment in admin-store.ts) — it only freezes scoring and bumps the
 *  reset epoch — so it can never clobber the policy fields just written.
 *
 *  The caller (the route) owns writing the `event-import` audit entry, the
 *  same split classic/quiz import routes already use. */
export async function importEventBundle(
  bundle: EventBundle,
  actor: string,
  now: Date = new Date(),
): Promise<{ summary: EventImportSummary; skipped: string[] }> {
  // Guard FIRST: nothing destructive below this line may run before the
  // event is confirmed non-live.
  const settings = await getAdminSettings();
  if (!effectivePaused(settings, now.getTime())) {
    throw new EventLiveError("Refusing to import into a live event — pause scoring first.");
  }

  // Same fail-fast discipline for sponsor logos: `importSponsors` below only
  // sniffs bytes as it writes, which is AFTER `resetEvent`. Sniff them here,
  // before anything destructive runs, so a bundle with a tampered/invalid
  // logo throws with the current event still intact.
  if (bundle.sponsors) validateBundleLogos(bundle.sponsors);

  // Apply (and validate) the settings patch BEFORE any destructive step. A
  // bad bundle throws `AdminValidationError` here, before `resetEvent` or any
  // clear/import has run — see the fail-fast note above.
  const { patch, skipped: moduleSkipped } = buildPolicyPatch(bundle.settings);
  // The bundle's identity block is applied like any other setting (issue
  // #386): through the one validated patch, before anything destructive.
  // contact/Discord never travel in a bundle (organizer PII — see the
  // header comment), so only these three can come back.
  patch.eventName = bundle.event.name;
  if (typeof bundle.event.theme === "string") patch.eventTheme = bundle.event.theme;
  if (typeof bundle.event.location === "string") patch.eventLocation = bundle.event.location;
  await updateAdminSettings(patch, actor);

  // Sweep run-state before touching content, so a mid-import failure never
  // leaves stale team/solve/hint state pointing at content that no longer
  // exists.
  await resetEvent(actor);

  // Replace-ALL: every archivable content store is cleared regardless of
  // which module sections this bundle carries. A quiz-only archive must wipe
  // any classic or ai content already on the target (and vice-versa) — this
  // is a replace of the box's whole content state to match the archive, not
  // a merge, so stale content from a module absent in the bundle must not
  // resurface later if that module gets re-enabled.
  await clearChallenges();
  await clearQuestions();
  await clearAiChallenges();

  const summary: EventImportSummary = {};

  if (bundle.classic) {
    const c = await importClassic(bundle.classic);
    summary.classic = { created: c.created, updated: c.updated };
  }

  if (bundle.quiz) {
    const q = await importQuiz(bundle.quiz);
    summary.quiz = { created: q.created, updated: q.updated };
  }

  if (bundle.ai) {
    const a = await importAi(bundle.ai);
    summary.ai = { created: a.created, updated: a.updated };
  }

  // No separate clear call needed before this: `resetEvent` above already
  // wiped both sponsor hashes (admin-store.ts's RESET_PREFIXES), unlike
  // classic/quiz/ai's clear*() calls, which exist because their CONTENT
  // survives a plain reset and only an archive import should wipe it.
  if (bundle.sponsors) {
    const s = await importSponsors(bundle.sponsors);
    summary.sponsors = { created: s.created };
  }

  const skipped: string[] = [...moduleSkipped];

  return { summary, skipped };
}

/** Reconciles a bundle's `enabledModuleIds` against what THIS deployment can
 *  actually run before it ever reaches `updateAdminSettings`. Every module
 *  besides `secure-development` is a plain runtime toggle now (issue #386) —
 *  there is no build-time set to match against any more. The only remaining
 *  availability constraint is `secureDevAvailable`: a deployment with no
 *  scorer image has no scorer/sync containers to score Secure Development's
 *  board, so `updateAdminSettings` refuses to enable it there
 *  (admin-store.ts's "one refusal left"). Importing an SD-enabled event's
 *  archive into a deployment that can't run it must not 500 — it should
 *  apply everything this deployment can actually serve and report the rest,
 *  never throw.
 *
 *  - Drops any id this deployment doesn't recognize as a module at all
 *    (`isModuleId`) — a typo, or an id from a newer build this deployment
 *    doesn't know.
 *  - Drops `secure-development` when `secureDevAvailable(process.env)` is
 *    false — the one case a valid, known id still can't be applied here.
 *
 *  Either drop is reported back via `skipped` so the caller can surface it;
 *  a set this deployment can run in full produces no messages. */
function reconcileEnabledModuleIds(incoming: readonly string[]): { ids: ModuleId[]; skipped: string[] } {
  const skipped: string[] = [];
  const unknown = incoming.filter((id) => !isModuleId(id));
  for (const id of unknown) {
    skipped.push(`Module "${id}" is not a recognized module id and was dropped from enabled modules.`);
  }
  const known = incoming.filter(isModuleId);

  if (known.includes("secure-development") && !secureDevAvailable(process.env)) {
    skipped.push(
      "Skipped enabling secure-development: this deployment has no scorer image (SCORE_IMAGE is unset), so its board could never be scored here.",
    );
    return { ids: known.filter((id) => id !== "secure-development"), skipped };
  }

  return { ids: known, skipped };
}

/** Translates the bundle's `EVENT_POLICY_FIELDS` allowlist into the shape
 *  `updateAdminSettings` actually accepts. Most fields are 1:1 by name, but
 *  two are not — `moduleOverrides` (a nested `{id: {title, blurb}}` map on
 *  read) has to flatten to the dynamic `moduleTitle:<id>`/`moduleBlurb:<id>`
 *  keys `updateAdminSettings` recognizes, and `enabledModuleIds` (the
 *  read-side name) writes under `enabledModules` (the write-side name).
 *  Copying either field's name straight through would make
 *  `updateAdminSettings` reject it as an unknown setting. A `null` value for
 *  either (settings' "no override" shape) is treated as "nothing to apply"
 *  rather than forwarded. An explicitly empty `enabledModuleIds` array IS
 *  forwarded, though — `[]` is a meaningful "no modules enabled" and every
 *  module besides secure-development is a plain runtime toggle now (issue
 *  #386), so there is no longer a build-time floor that makes an empty set
 *  invalid.
 *
 *  `enabledModuleIds` is additionally reconciled against this deployment's
 *  actual availability via `reconcileEnabledModuleIds` before landing in the
 *  patch — see that function's doc comment. The reconciliation's own
 *  messages are returned alongside the patch so `importEventBundle` can fold
 *  them into its `skipped` array instead of letting a mismatch throw.
 *
 *  `secureDevTargets` is 1:1 by name but gets the same treat-as-`skipped`
 *  contract as the reconciliation above, for a different reason: an absent
 *  or all-unknown target list is a validation error on a direct admin write
 *  (`checkSecureDevTargets` never returns an empty list — see
 *  admin-store.ts's write branch), but rejecting the WHOLE import over one
 *  bad field in an otherwise-good archive would be exactly the throw this
 *  function exists to avoid. */
function buildPolicyPatch(settings: EventPolicySettings): { patch: SettingsPatch; skipped: string[] } {
  const patch: SettingsPatch = {};
  const skipped: string[] = [];
  for (const field of EVENT_POLICY_FIELDS) {
    if (!(field in settings)) continue;
    const value = settings[field];
    if (field === "moduleOverrides") {
      const overrides = value as ModuleOverrides | null | undefined;
      if (!overrides) continue;
      for (const [id, slot] of Object.entries(overrides)) {
        if (!isModuleId(id) || !slot) continue;
        if (slot.title !== undefined) patch[`moduleTitle:${id}`] = slot.title;
        if (slot.blurb !== undefined) patch[`moduleBlurb:${id}`] = slot.blurb;
      }
    } else if (field === "enabledModuleIds") {
      const ids = value as ModuleId[] | null | undefined;
      // Array.isArray, not a truthiness/length check: `[]` is a meaningful
      // "no modules enabled" and must round-trip, not be treated the same as
      // the field being absent/null (see the doc comment above).
      if (Array.isArray(ids)) {
        const reconciled = reconcileEnabledModuleIds(ids);
        skipped.push(...reconciled.skipped);
        patch.enabledModules = reconciled.ids;
      }
    } else if (field === "secureDevTargets") {
      // Validated the same way updateAdminSettings validates a direct write
      // — never a throw here, unlike that path: a bad/unknown target list in
      // an otherwise-good archive must not fail the whole import, it should
      // just skip this one field and apply everything else (the same
      // "report, don't throw" contract `reconcileEnabledModuleIds` follows
      // above). An absent field leaves `patch.secureDevTargets` unset, so
      // updateAdminSettings never touches the stored value at all.
      const check = checkSecureDevTargets(value);
      if (check.ok) {
        patch.secureDevTargets = check.value;
      } else {
        skipped.push(`Skipped secureDevTargets: ${check.message}`);
      }
    } else {
      // The 10 scalar policy fields are `X | null` on AdminSettings/the
      // bundle (null = "no override"), but SettingsPatch types them
      // non-nullable and updateAdminSettings throws on a null. Skip, same as
      // the moduleOverrides/enabledModuleIds null guards above — forwarding
      // null here would round-trip a fresh export straight into a throw.
      if (value === null || value === undefined) continue;
      (patch as Record<string, unknown>)[field] = value;
    }
  }
  return { patch, skipped };
}
