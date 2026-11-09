// The module on/off switch's rules, as pure functions — shared by the Event
// tab's Modules section and each module panel's own header switch
// (admin-redesign.md § Content screens), so the two places an organizer can
// flip a module can never disagree about when it is locked or what the
// confirmation says.
//
// Secure Development is runtime-toggleable now (#386): it locks only when
// the deployment has no scorer image, mirroring the server's own refusal.
// Every other module — including the last live one — can be switched off;
// an empty event is legal, and the landing page says so instead of showing
// a broken board.

import { ALL_MODULE_IDS, moduleDefById, type ModuleDeprecation } from "@/lib/modules";

export type ModuleToggleChoice = {
  id: string;
  label: string;
  /** False only for secure-development on a deployment with no scorer
   *  image. `reason` says so on the row instead of leaving a dead control. */
  toggleable: boolean;
  reason?: string;
  /** The registry's `ModuleDef.deprecated`, for the switch's help line and
   *  the enable confirmation. */
  deprecated?: ModuleDeprecation;
};

/** One row per registered module. Secure Development is locked only when
 *  the deployment has no scorer image — the server refuses the same write,
 *  this is the panel's copy of that rule (issue #386). Nothing else is
 *  locked: switching the last board off is an organizer's decision, and the
 *  landing page says so instead of showing an empty grid. */
export function moduleChoices(secureDevAvailable: boolean): readonly ModuleToggleChoice[] {
  return ALL_MODULE_IDS.map((id) => ({
    id: id as string,
    label: moduleDefById(id)?.displayName ?? (id as string),
    toggleable: id !== "secure-development" || secureDevAvailable,
    deprecated: moduleDefById(id)?.deprecated,
    reason:
      id === "secure-development" && !secureDevAvailable
        ? "This deployment has no scorer image (SCORE_IMAGE is unset), so Secure Development cannot run here. Configure SCORE_IMAGE for this deployment and redeploy."
        : undefined,
  }));
}

/** What the switch for one module shows: on or off, whether it can be
 *  flipped, and the one sentence that explains a locked switch.
 *
 *  A non-toggleable module that is already ON is not locked (issue #386): a
 *  stored secure-development can outlive its scorer image. It stays
 *  switchable off directly (`disabled: false`) — but the server now strips
 *  it from what gets stored on ANY module write, not just a direct toggle
 *  (admin-store's carry-forward rule, CodeRabbit round 1 finding B), so the
 *  help text says so rather than implying the switch is the only way off.
 *  Only a non-toggleable module that is OFF stays locked, since turning it
 *  ON is the one write the server still refuses. */
export function moduleToggleState(
  mod: ModuleToggleChoice,
  live: ReadonlySet<string>,
): { on: boolean; disabled: boolean; help: string | undefined; deprecated?: ModuleDeprecation } {
  const on = live.has(mod.id);
  const deprecated = mod.deprecated;
  if (mod.toggleable) return { on, disabled: false, help: undefined, deprecated };
  if (on) return { on, disabled: false, help: `${mod.reason} It is switched off on your next change to any module.`, deprecated };
  return { on, disabled: true, help: mod.reason, deprecated };
}

/** The confirmation for flipping one module, and the enabled set it writes.
 *  Same words on Event and on the module's own panel. */
export function moduleToggleConfirm(
  mod: ModuleToggleChoice,
  next: boolean,
  live: ReadonlySet<string>,
): { title: string; body: string; confirmLabel: string; ids: string[]; deprecated?: ModuleDeprecation } {
  const ids = next ? [...live, mod.id] : [...live].filter((id) => id !== mod.id);
  return {
    title: next ? `Enable ${mod.label}?` : `Disable ${mod.label}?`,
    body: next
      ? `${mod.label} appears in the nav and its board opens, for everyone, on their next page load.`
      : `${mod.label} disappears from the nav and its board stops resolving, for everyone, on their next page load. Nothing is deleted — enabling it again brings the same board back.`,
    confirmLabel: next ? "Enable" : "Disable",
    ids,
    // Said when switching a deprecated module ON, the moment it matters.
    deprecated: next ? mod.deprecated : undefined,
  };
}
