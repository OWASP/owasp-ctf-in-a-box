"use client";

// Which clock the admin activity times read on. The event's own zone is the
// default, so a row lines up with the header and the schedule above it; a
// per-browser "Show UTC" switch flips the rows to UTC for matching an entry
// against server logs. Overview's Recent activity and the Activity tab share
// one stored preference, so the switch follows the organizer between them.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "ctf-admin-activity-utc";

/** The zone the activity rows format in. */
export function activityZone(eventZone: string, utc: boolean): string {
  return utc ? "UTC" : eventZone;
}

// The choice lives in localStorage, with this module's copy as the fallback
// when storage throws (private window, blocked site data) — the switch then
// lasts for the page only. Listeners let both views on the panel follow a
// flip made in either.
let memory = false;
const listeners = new Set<() => void>();

function readUtc(): boolean {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? memory : stored === "1";
  } catch {
    return memory;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function writeUtc(next: boolean): void {
  memory = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Storage unavailable: `memory` carries the choice for this page.
  }
  for (const listener of listeners) listener();
}

/** The stored "Show UTC" choice. The server snapshot is always false, so the
 *  server render and hydration agree on the event zone; the stored choice
 *  applies once the client takes over. */
export function useShowUtc(): [boolean, (utc: boolean) => void] {
  const utc = useSyncExternalStore(subscribe, readUtc, () => false);
  return [utc, writeUtc];
}

export function UtcToggle({ checked, onChange }: { checked: boolean; onChange: (utc: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-zinc-400">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="h-3.5 w-3.5 accent-[#2563eb]"
      />
      Show UTC
    </label>
  );
}
