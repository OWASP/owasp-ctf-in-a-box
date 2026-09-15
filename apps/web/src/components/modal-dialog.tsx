"use client";

// The modal shell every admin dialog shares: the overlay, the panel, and the
// three things WAI-ARIA's "Dialog (Modal)" pattern actually requires of a
// dialog that claims `aria-modal="true"` — focus moves in, Tab stays in,
// focus goes back out to the opener on close.
//
// This was ConfirmModal's alone until the sponsor editor needed a dialog of
// its own. Two copies of a focus trap is two places for it to rot, on the one
// screen in this app whose buttons wipe an event, so the trap lives here and
// ConfirmModal is now a body/footer on top of it.
//
// Mount this only while open (`{open && <ModalDialog .../>}`) so each open is
// a fresh mount: the effects below are plain mount effects, and any state a
// caller keeps in its body resets naturally with no extra wiring.

import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

export type ModalDialogProps = {
  /** Names the dialog for assistive tech AND renders as its heading. */
  title: string;
  /** Red heading for destructive actions; the caller styles its own footer. */
  danger?: boolean;
  /** While true, Escape and overlay clicks stop dismissing the dialog — an
   *  action is in flight and cancelling it would lie about what happened. */
  pending?: boolean;
  /** What Escape, the overlay and (by convention) the footer's Cancel do. */
  onCancel: () => void;
  /** Focused on mount when given — the first field of a form, or the
   *  type-to-confirm box. Falls back to the panel itself, which is a
   *  programmatic-only focus target, so the dialog's name is announced. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Tailwind max-width for the panel. A form needs more room than a
   *  confirmation does. */
  maxWidthClass?: string;
  children: ReactNode;
};

export default function ModalDialog({
  title,
  danger = false,
  pending = false,
  onCancel,
  initialFocusRef,
  maxWidthClass = "max-w-md",
  children,
}: ModalDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves INTO the dialog on mount and back to the opener on unmount.
  //
  // The ordering IS the fix, and it is why nothing in a dialog built on this
  // shell may use React's `autoFocus`: React applies `autoFocus` during
  // commit, BEFORE this passive effect runs, so by the time the line below
  // reads `document.activeElement` it would already be the autofocused field
  // rather than the control that opened the dialog — and the cleanup would
  // then "restore" focus to an element being unmounted, dropping it on
  // <body>. That is the exact failure this effect exists to prevent, hidden
  // behind code that looks like it works.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (initialFocusRef?.current ?? panelRef.current)?.focus();
    return () => opener?.focus?.();
  }, [initialFocusRef]);

  // Escape cancels (but never mid-flight), and Tab is confined to the dialog.
  // Both live on one listener because both are the same contract: while this
  // is open, the keyboard belongs to it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) {
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      // Queried per keypress rather than cached: a dialog's controls flip
      // between enabled and disabled as it is filled in (a Confirm button
      // waiting on a typed phrase, a Save waiting on a required field), and a
      // disabled control is not focusable — a cached list would wrap to a
      // control the browser then skips.
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => !pending && onCancel()}
    >
      {/* tabIndex={-1} makes the panel a programmatic focus target only — it
          is never reached by Tab, so it is the one place in this app that
          suppresses the amber ring rather than showing it: a ring drawn
          around the whole dialog the moment it opens reads as an error
          state, and there is no keyboard user to serve it to. Every control
          INSIDE keeps its ring. */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`my-auto w-full ${maxWidthClass} rounded-lg border border-white/10 bg-[#16162a] p-5 shadow-2xl focus:outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className={`text-base font-semibold ${danger ? "text-[#e53e3e]" : "text-white"}`}>{title}</h3>
        {children}
      </div>
    </div>
  );
}
