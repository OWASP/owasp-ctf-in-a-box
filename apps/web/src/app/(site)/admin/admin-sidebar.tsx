"use client";

// The admin shell's navigation (admin-redesign.md PR 1): a left sidebar in
// three groups, collapsing to a top drawer below `lg`. Replaces the old
// horizontal WAI-ARIA tabs strip — this is plain `<nav>` + real links, so
// keyboard operation (Tab through items, Enter/Space to activate, and the
// drawer toggle button) comes from the browser for free; there is no roving
// tabindex or arrow-key handling to maintain.
//
// Owns ONLY navigation state: which destination is active, and whether the
// mobile drawer is open. `admin-controls.tsx` still owns every settings
// field and every panel's content — this component never reads or writes
// any of that.
//
// Real `href`s (not buttons) so a middle-click / "open in new tab" still
// works and the link is meaningful with JS disabled, but the click handler
// prevents the default navigation: every destination is a panel already
// rendered into this same page (see admin-controls.tsx's `hidden` panels),
// so switching one in is a state change, not a page load.

import { useState } from "react";
import { adminTabHref } from "@/app/(site)/admin/admin-tabs";

type SidebarItem = { id: string; label: string };
export type SidebarGroup = { heading: string; items: readonly SidebarItem[] };

export default function AdminSidebar({
  groups,
  active,
  onSelect,
}: {
  groups: readonly SidebarGroup[];
  /** The active destination's id. Exactly one item across every group gets
   *  `aria-current="page"`. */
  active: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col lg:w-56 lg:flex-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="admin-sidebar-nav"
        className="mb-3 flex items-center justify-between gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-200 lg:hidden"
      >
        <span>Sections</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {open ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M3 12h18M3 6h18M3 18h18" />}
        </svg>
      </button>

      <nav
        id="admin-sidebar-nav"
        aria-label="Admin sections"
        className={`${open ? "flex" : "hidden"} flex-col gap-5 rounded-md border border-white/[0.06] bg-[#12121e] p-3 lg:flex lg:border-none lg:bg-transparent lg:p-0`}
      >
        {groups.map((group) => (
          <div key={group.heading}>
            <h3 className="px-2 text-xs font-semibold uppercase tracking-wider text-muted">{group.heading}</h3>
            <ul className="mt-1 flex flex-col gap-0.5">
              {group.items.map((item) => {
                const isActive = active === item.id;
                return (
                  <li key={item.id}>
                    <a
                      href={adminTabHref(item.id)}
                      aria-current={isActive ? "page" : undefined}
                      onClick={(e) => {
                        // A modified click (Cmd/Ctrl/Shift/Alt, or a non-primary
                        // button) is "open elsewhere" — the browser's job, and
                        // the reason these are real links.
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                        e.preventDefault();
                        onSelect(item.id);
                        setOpen(false);
                      }}
                      className={
                        isActive
                          ? "block rounded-md bg-white/[0.06] px-2 py-1.5 text-sm font-medium text-white"
                          : "block rounded-md px-2 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-white"
                      }
                    >
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
