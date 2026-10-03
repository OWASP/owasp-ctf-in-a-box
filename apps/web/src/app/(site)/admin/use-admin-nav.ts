"use client";

// The admin shell's destinations and which one is open (issue #504, M11,
// extracted from admin-controls.tsx): the tab ids with the comments saying
// where each sits and why, the tab list, the sidebar's three groups, the
// active-tab state, the pushState that keeps the address bar in step with a
// click, and the popstate handler that moves the panel when Back/Forward
// walk the history.
//
// The URL⇄tab rules themselves stay in admin-tabs.ts — a module with no
// `"use client"`, because the two routes CALL them on the server (issue
// #312); this file only consumes them on the client side of that boundary.

import { useCallback, useEffect, useState } from "react";
import type { ResolvedModule } from "@/lib/modules";
import type { SidebarGroup } from "./admin-sidebar";
import { adminTabHref, tabFromLocation } from "@/app/(site)/admin/admin-tabs";

// The landing destination (admin-redesign.md PR 1): "is scoring on, how many
// teams, is anything stuck" answered in one screen rather than three tabs.
// Also the fallback for a deep link this shell doesn't recognise — a stale
// bookmark or a typo lands an organizer somewhere real, not on nothing.
export const OVERVIEW_TAB = "overview";
/** The always-present control-plane tab. Module tabs follow it, in the order
 *  the event config lists them. */
export const EVENT_TAB = "event";
// The hint policy's own destination (admin-redesign.md's Event/Hints/Admins
// split) — see admin-hints-tab.tsx for why it isn't a module's or Event's.
export const HINTS_TAB = "hints";
/** Runtime admin management (issue #147). Sits beside Event rather than
 *  inside it: it manages WHO may use the panel, not what the event does. */
export const ADMINS_TAB = "admins";
// Sponsor recognition (issue #405) — a platform feature, not a module, so it
// sits beside Event/Hints/Admins rather than in the module tab row.
export const SPONSORS_TAB = "sponsors";
// Live-event support (issue #168). Sits after Admins and before the module
// tabs: it is control-plane, not module-specific, and an organizer reaching
// for it is mid-incident rather than mid-configuration.
export const SUPPORT_TAB = "support";
// Engagement metrics (issue #169). Control-plane like Event/Admins/Support,
// and last of the four because it is read-only — an organizer reaches for it
// after the event more often than during it.
export const INSIGHTS_TAB = "insights";
// The activity log (issue #212). Read-only like Insights but LIVE — an
// organizer reaches for it mid-event ("did anyone sign in yet?", "who just
// solved that?"), so it sits between Support and Insights.
export const ACTIVITY_TAB = "activity";

export function useAdminNav({
  modules,
  initialTab,
}: {
  /** The enabled modules, in the order `modules` lists them — the same
   *  order the flat tab row used, and the Content group's order. */
  modules: readonly ResolvedModule[];
  /** Which tab to open on arrival, from `/admin?tab=<module id>`. Anything
   *  this shell doesn't recognise — a typo, or a module this event didn't
   *  enable — falls back to Overview rather than opening nothing. Resolved
   *  on the server (see page.tsx) so the first render already has the right
   *  panel open; the organizer never sees it flip. */
  initialTab?: string;
}): {
  tabs: { id: string; label: string }[];
  sidebarGroups: readonly SidebarGroup[];
  active: string;
  setActive: (id: string) => void;
  selectTab: (id: string) => void;
} {
  const tabs = [
    { id: OVERVIEW_TAB, label: "Overview" },
    { id: EVENT_TAB, label: "Event" },
    { id: HINTS_TAB, label: "Hints" },
    { id: ADMINS_TAB, label: "Admins" },
    { id: SPONSORS_TAB, label: "Sponsors" },
    { id: SUPPORT_TAB, label: "Support" },
    { id: ACTIVITY_TAB, label: "Activity" },
    { id: INSIGHTS_TAB, label: "Insights" },
    ...modules.map((mod) => ({ id: mod.id as string, label: mod.title })),
  ];
  const [active, setActive] = useState<string>(
    tabs.some((t) => t.id === initialTab) ? (initialTab as string) : OVERVIEW_TAB,
  );

  // Switching tabs is client-side state (instant, no server round-trip), so
  // the address bar has to be told about it — otherwise the panel shows
  // Activity while the URL still reads /admin/overview, and an organizer
  // pasting "the link I'm looking at" sends the wrong screen. pushState keeps
  // the two in step and leaves a real history entry, so Back walks the tabs.
  const selectTab = useCallback((id: string) => {
    setActive(id);
    window.history.pushState(null, "", adminTabHref(id));
  }, []);

  // …and Back/Forward has to move the panel, not just the URL.
  const tabIds = tabs.map((t) => t.id).join(",");
  useEffect(() => {
    const onPop = () => {
      const id = tabFromLocation(window.location.pathname, window.location.search);
      setActive(tabIds.split(",").includes(id) ? id : OVERVIEW_TAB);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [tabIds]);

  // The sidebar's three groups (admin-redesign.md). CONTENT is every enabled
  // module, in the order `modules` lists them — the same order the flat tab
  // row used.
  const sidebarGroups: readonly SidebarGroup[] = [
    {
      heading: "Run",
      items: [
        { id: OVERVIEW_TAB, label: "Overview" },
        { id: ACTIVITY_TAB, label: "Activity" },
        { id: INSIGHTS_TAB, label: "Insights" },
        { id: SUPPORT_TAB, label: "Support" },
      ],
    },
    {
      heading: "Content",
      items: modules.map((mod) => ({ id: mod.id as string, label: mod.title })),
    },
    {
      heading: "Setup",
      items: [
        { id: EVENT_TAB, label: "Event" },
        { id: HINTS_TAB, label: "Hints" },
        { id: ADMINS_TAB, label: "Admins" },
        { id: SPONSORS_TAB, label: "Sponsors" },
      ],
    },
  ];

  return { tabs, sidebarGroups, active, setActive, selectTab };
}
