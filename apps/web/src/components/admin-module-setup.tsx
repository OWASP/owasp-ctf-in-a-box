"use client";

// The setup status that heads every module's admin panel — the rendering of
// `ModuleDef.setup` (see `ModuleSetupContent` in `@/lib/modules`). One
// component for all four modules, and for the next one: the content is
// registry data, this is the only renderer, so a new module gets its panel by
// filling in a registry block and nothing else.
//
// Shape (admin-redesign.md § Content screens): ONE status line — "Setup
// complete · 4 categories · 12 challenges" — that opens into the checklist,
// plus a second line that opens the "safe / not safe mid-event" help. The
// checklist is EXPANDED until every step this panel can verify is satisfied,
// then collapses to the line; before the admin redesign it opened expanded
// on every visit, so the actual controls began one to two screens down for
// the rest of the event (UX audit, redesign § Why 5).
//
// Steps done OUTSIDE this panel (`where: "outside"` — .env, the GitHub
// org, ctf-setup.sh) are not listed: this panel exists only while the
// module is enabled, so every one of them is behind the organizer already.
// The guide link at the bottom still carries them for anyone re-provisioning.
//
// Purely presentational. The content arrives already resolved (the registry
// block is a function of live event facts and is CALLED server-side, in
// /admin's page — see `getModuleSetup`), and the live counts arrive as
// `inventory`, reported up to the shell by the module's own list panel once
// its mount-time fetch has settled. Until that happens `inventory` is
// undefined and the line says "checking…": on first paint the panel does not
// yet know whether questions exist, and saying "None yet" — or opening the
// checklist — there would accuse a fully set-up module for the second it
// takes the list to load.

import type { ModuleSetupContent, SetupStep } from "@/lib/modules";
import ModuleCopy from "@/components/module-copy";

/** The counts a module's list panel knows about itself. Every key optional:
 *  the quiz has no categories, and a panel that has not loaded yet has
 *  none of them — which is what keeps `unlisted` from accusing a healthy
 *  board on first paint. */
export type ModuleInventory = {
  items?: number;
  categories?: number;
  /** Items whose `category` is not in the stored category list, and which the
   *  contestant board therefore does not render at all. Reported only by the
   *  boards that have categories; the quiz omits it. */
  unlisted?: number;
};

type SetupStepStatus = "done" | "todo" | "unknown";

/** What the panel can honestly say about one step. `null` for a step that
 *  declares no `check` — nothing to say, so nothing is shown. `"unknown"`
 *  while the count it depends on has not been reported; never a tick or a
 *  cross the panel cannot back. Exported for direct testing. */
export function setupStepStatus(step: SetupStep, inventory: ModuleInventory | undefined): SetupStepStatus | null {
  if (!step.check) return null;
  const n = inventory?.[step.check.count];
  if (typeof n !== "number") return "unknown";
  return n > 0 ? "done" : "todo";
}

/** The count line beside a checkable step: "Checking…", "None yet", or
 *  "3 questions" / "1 question". Exported for direct testing. */
export function setupCountLabel(step: SetupStep, inventory: ModuleInventory | undefined): string | null {
  const status = setupStepStatus(step, inventory);
  if (status === null || !step.check) return null;
  if (status === "unknown") return "Checking…";
  if (status === "todo") return "None yet";
  const n = inventory?.[step.check.count] ?? 0;
  const noun = n === 1 ? (step.check.one ?? step.check.noun.replace(/s$/, "")) : step.check.noun;
  return `${n} ${noun}`;
}

/** The steps this panel shows: the ones done here. See the header comment
 *  for why the outside ones are not repeated. Exported for direct testing. */
export function panelSteps(setup: ModuleSetupContent): SetupStep[] {
  return setup.steps.filter((s) => s.where === "panel");
}

/** Whether every step this panel can verify is done: `true`, `false`, or
 *  `null` while a count is still unknown. A setup with nothing checkable
 *  (secure-development: all provisioning) has no verdict to give and counts
 *  as complete — there is nothing to expand for. Exported for direct testing. */
export function setupComplete(setup: ModuleSetupContent, inventory: ModuleInventory | undefined): boolean | null {
  const statuses = setup.steps.filter((s) => s.check).map((s) => setupStepStatus(s, inventory));
  if (statuses.length === 0) return true;
  if (statuses.some((s) => s === "unknown")) return null;
  return statuses.every((s) => s === "done");
}

/** "setup complete · 4 categories · 12 challenges" — the status line, and
 *  Overview's per-module line, from the same rule so the two never disagree
 *  about what "done" means. A module the registry gave no setup block, or one
 *  whose steps are all uncountable provisioning, just says "enabled"; one
 *  whose counts have not arrived says "checking…", never "incomplete".
 *  Exported for direct testing. */
export function moduleSummary(setup: ModuleSetupContent | undefined, inventory: ModuleInventory | undefined): string {
  if (!setup) return "enabled";
  const checkable = setup.steps.filter((s) => s.check);
  if (checkable.length === 0) return "enabled";
  const complete = setupComplete(setup, inventory);
  if (complete === null) return "checking…";
  const counts = checkable
    .map((s) => setupCountLabel(s, inventory))
    .filter((label): label is string => label !== null && label !== "None yet");
  // Appended to the line rather than folded into the verdict: the setup IS
  // complete — every step was done — and the problem is that some of the
  // content it produced is off the board. Saying "setup incomplete" would
  // point the organizer at the checklist, which has nothing wrong with it.
  const unlisted = unlistedLabel(inventory);
  return [complete ? "setup complete" : "setup incomplete", ...counts, ...(unlisted ? [unlisted] : [])].join(" · ");
}

/** "3 not on the board" — the count of items whose category is missing from
 *  the stored list, or null when there are none (or when the panel has not
 *  reported yet). Exported for direct testing. */
export function unlistedLabel(inventory: ModuleInventory | undefined): string | null {
  const n = inventory?.unlisted;
  if (typeof n !== "number" || n <= 0) return null;
  return `${n} not on the board`;
}

const STATUS_CLASS: Record<SetupStepStatus, string> = {
  done: "text-[#22c55e]",
  todo: "text-[#d4a017]",
  unknown: "text-muted",
};

export default function AdminModuleSetup({
  title,
  setup,
  inventory,
}: {
  /** The module's resolved title — the panel's own heading. */
  title: string;
  setup: ModuleSetupContent;
  inventory?: ModuleInventory;
}) {
  const complete = setupComplete(setup, inventory);
  const steps = panelSteps(setup);
  const hiddenOutside = setup.steps.length - steps.length;
  const summary = moduleSummary(setup, inventory);
  const unlisted = inventory?.unlisted ?? 0;
  // Amber for unreachable challenges too, not just an unfinished checklist:
  // a green "setup complete" above an amber warning is the same contradiction
  // #344 shipped, one line further up.
  const tone =
    complete === false || unlisted > 0
      ? "text-[#d4a017]"
      : complete === true && summary !== "enabled"
        ? "text-[#22c55e]"
        : "text-muted";

  return (
    <div className="flex flex-col gap-1 border-b border-white/[0.06] pb-3 text-sm">
      {unlisted > 0 && (
        // The state this warning names is reachable three ways: the demo seed
        // used to replace the category list outright (#344), an organizer can
        // remove a category by hand, and an import can arrive spelling one
        // differently. However it is reached, the panel keeps listing the
        // challenges — under headings absent from the list one line above —
        // while the board renders none of them, which is why "5 challenges"
        // read like a healthy setup. Say it here, where the fix is.
        <p role="status" className="rounded-md border border-[#d4a017]/40 bg-[#d4a017]/[0.08] px-3 py-2 text-[#d4a017]">
          {unlisted === 1 ? "1 challenge is" : `${unlisted} challenges are`} in a category that is not in the list
          below, so contestants never see {unlisted === 1 ? "it" : "them"}. Add the missing{" "}
          {unlisted === 1 ? "category" : "categories"}, or move{" "}
          {unlisted === 1 ? "the challenge" : "the challenges"} into one that is listed.
        </p>
      )}
      {/* Open while anything checkable is still to do — or while challenges
          are off the board, since the missing category is added from the
          control the checklist points at; collapsed to the line once both are
          settled (or while the counts are still unknown — never accuse on
          first paint). Native <details>: the whole checklist stays in the
          static markup, and the organizer can reopen it any time. */}
      <details open={complete === false || unlisted > 0} className="group">
        <summary className="cursor-pointer text-muted">
          <span className={`font-medium ${tone}`}>{summary.charAt(0).toUpperCase() + summary.slice(1)}</span>
          {" · "}
          <span className="group-open:hidden">details</span>
          <span className="hidden group-open:inline">hide</span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm font-medium text-white">Setting up {title}</p>
          <p className="text-muted">{setup.experience}</p>

          {steps.length > 0 && (
            <ol className="flex flex-col gap-2">
              {steps.map((step, i) => {
                const status = setupStepStatus(step, inventory);
                const label = setupCountLabel(step, inventory);
                return (
                  <li key={step.title} className="flex items-start gap-3 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <span aria-hidden="true" className="w-4 flex-none font-mono text-muted">
                      {i + 1}.
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-white">{step.title}</p>
                      {step.body && (
                        <p className="mt-0.5 text-muted">
                          <ModuleCopy copy={step.body} />
                        </p>
                      )}
                    </div>
                    {status && label && <span className={`flex-none ${STATUS_CLASS[status]}`}>{label}</span>}
                  </li>
                );
              })}
            </ol>
          )}

          {hiddenOutside > 0 && (
            <p className="text-muted">
              {hiddenOutside === 1 ? "One provisioning step" : `${hiddenOutside} provisioning steps`} done outside this panel{" "}
              {hiddenOutside === 1 ? "is" : "are"} not repeated here — the module is enabled, so{" "}
              {hiddenOutside === 1 ? "it is" : "they are"} behind you. The guide below has{" "}
              {hiddenOutside === 1 ? "it" : "them"}.
            </p>
          )}

          <p>
            <a href={setup.docs.href} target="_blank" rel="noopener noreferrer" className="ds-link">
              {setup.docs.label}
            </a>
          </p>
        </div>
      </details>

      {/* The help drawer: what may change while contestants are playing. Off
          the checklist, because it is read mid-event, long after setup. */}
      <details className="group">
        <summary className="cursor-pointer text-muted">
          What is safe to change mid-event · <span className="group-open:hidden">show</span>
          <span className="hidden group-open:inline">hide</span>
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-white">Safe to change mid-event</p>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-muted">
              {setup.midEvent.safe.map((line, i) => (
                <li key={i}>
                  <ModuleCopy copy={line} />
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-white">Not safe mid-event</p>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-muted">
              {setup.midEvent.unsafe.map((line, i) => (
                <li key={i}>
                  <ModuleCopy copy={line} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}
