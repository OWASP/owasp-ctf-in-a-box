"use client";

// One module's Content screen (admin-redesign.md § Content screens): the
// sticky header — the module's own title and its enabled switch — the setup
// status line that opens into the checklist, and then the module's own
// controls (`children`: the quiz, classic, ai or secure-development panel),
// which open with the compact settings card (components/admin/settings-
// card.tsx). The identity editor is built HERE — it is driven by the modules
// list, not by any module's code — and handed to the controls through the
// `children` render prop so they can place it inside that card above their
// own knobs. Extracted from admin-controls.tsx so the shell stays a shell;
// driven by the modules list and the `setups` map, so a fifth module gets
// this screen with no per-module branch.
//
// The enabled switch is the SAME control as the row on Event's Modules
// section — same status key (`module:<id>`), same lock rule and confirmation
// (module-toggle.ts) — so a flip made here reports "Saved" there too.
// Switching the module off keeps this panel mounted (the shell's tab list is
// the enabled set as of page load); the organizer sees the switch go off and
// the nav drop the module on their next load, exactly as Event's row says.
//
// Presentational: state and writes are the shell's, passed in.

import type { ReactNode } from "react";
import type { AdminSettings } from "@/lib/admin-store";
import type { ModuleSetupContent, ResolvedModule } from "@/lib/modules";
import AdminModuleSetup, { type ModuleInventory } from "@/components/admin-module-setup";
import AdminSwitch from "@/components/admin-switch";
import type { FieldStatus } from "@/components/admin-number-field";
import type { ModuleSettingsSlot } from "@/components/admin/settings-card";
import AdminModuleIdentity from "./admin-module-identity";
import { withDeprecation } from "./module-deprecation";
import { moduleToggleConfirm, moduleToggleState, type ModuleToggleChoice } from "./module-toggle";
import type { ConfirmState } from "./types";

export default function AdminModulePanel({
  mod,
  choice,
  liveModuleIds,
  setup,
  inventory,
  defaults,
  settings,
  pending,
  apply,
  applyField,
  statusOf,
  setConfirm,
  sellsHints,
  onNavigateHints,
  children,
}: {
  mod: ResolvedModule;
  /** The registry's row for this module (label, whether it can be toggled). */
  choice: ModuleToggleChoice;
  /** The ids live right now: the runtime set, or the default one when no
   *  override is stored. */
  liveModuleIds: readonly string[];
  setup?: ModuleSetupContent;
  inventory?: ModuleInventory;
  /** Registry defaults for the identity editor's placeholders. */
  defaults: { title: string; blurb: string };
  settings: AdminSettings;
  pending: boolean;
  apply: (patch: Record<string, unknown>) => Promise<boolean>;
  applyField: (key: string, patch: Record<string, unknown>, label: string) => Promise<boolean>;
  statusOf: (key: string) => FieldStatus;
  setConfirm: (c: ConfirmState) => void;
  /** Whether this module sells hints — the settings card then links to the
   *  Hints screen, where their price and gating live. The quiz does not. */
  sellsHints: boolean;
  onNavigateHints: () => void;
  /** The module's own controls, given the settings-card slot to render the
   *  identity editor and Hints link inside their card. */
  children: (settings: ModuleSettingsSlot) => ReactNode;
}) {
  const live = new Set(liveModuleIds);
  const toggle = moduleToggleState(choice, live);
  const settingsSlot: ModuleSettingsSlot = {
    identity: (
      <AdminModuleIdentity
        moduleId={mod.id}
        defaults={defaults}
        override={settings.moduleOverrides[mod.id as keyof AdminSettings["moduleOverrides"]]}
        pending={pending}
        apply={apply}
      />
    ),
    onHints: sellsHints ? onNavigateHints : undefined,
  };

  return (
    <section className="flex flex-col gap-4">
      {/* Sticky so the module's name and its switch stay in view while the
          organizer scrolls a long board. Opaque over the page background
          (globals.css --background) so rows never show through the text. */}
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 bg-[#1a1a2e]/95 px-1 py-2 backdrop-blur">
        <h2 className="text-base font-semibold text-white">{mod.title}</h2>
        {/* The lock reason (a non-toggleable module, or the last live one) is
            rendered under the header as its own line rather than as the
            switch's help: in this narrow column it wrapped into four lines
            and made the sticky header a third of the screen. */}
        <div className="w-40">
          <AdminSwitch
            id={`module-panel-${mod.id}`}
            label="Enabled"
            checked={toggle.on}
            disabled={pending || toggle.disabled}
            status={statusOf(`module:${mod.id}`)}
            onChange={(next) => {
              const c = moduleToggleConfirm(choice, next, live);
              setConfirm({
                title: c.title,
                body: withDeprecation(c.body, c.deprecated),
                confirmLabel: c.confirmLabel,
                onConfirm: () => applyField(`module:${mod.id}`, { enabledModules: c.ids }, choice.label),
              });
            }}
          />
        </div>
      </div>

      {(toggle.help || toggle.deprecated) && (
        <p className="-mt-2 text-sm text-muted">{withDeprecation(toggle.help, toggle.deprecated)}</p>
      )}

      {setup && <AdminModuleSetup title={mod.title} setup={setup} inventory={inventory} />}

      {children(settingsSlot)}
    </section>
  );
}
