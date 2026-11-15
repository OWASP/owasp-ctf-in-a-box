"use client";

// The delete confirmation the module admin panels (quiz, classic) share:
// `ConfirmModal` in its destructive, type-to-confirm shape — Confirm stays
// disabled until the organizer types the item's own phrase (see
// components/admin/confirm-phrase.ts) — with the line a failed DELETE lands on
// rendered under the body, and Cancel ignored while the request is in flight
// so the modal cannot vanish from under a write that is still running.
//
// Presentational. The panel owns the target, the copy (its own
// `xDeleteConfirm` builder — the sentences differ per module and stay there),
// the pending flag and the error; this component only arranges them the one
// way all three panels did by hand.

import ConfirmModal from "@/components/confirm-modal";

/** What a module's `xDeleteConfirm` builder produces: the modal's title, its
 *  body sentence, the phrase to retype, and the Confirm label. */
export type DeleteConfirmCopy = {
  title: string;
  body: string;
  requireType: string;
  confirmLabel: string;
};

/** Cancel is a no-op while a delete is pending. Exported so the guard is
 *  provable by direct call — this repo's tests cannot click. */
export function guardedCancel(pending: boolean, onCancel: () => void): () => void {
  return () => {
    if (pending) return;
    onCancel();
  };
}

export default function ConfirmDelete({
  copy,
  error,
  pending,
  onConfirm,
  onCancel,
}: {
  copy: DeleteConfirmCopy;
  /** The last DELETE's failure, or null. */
  error: string | null;
  pending: boolean;
  onConfirm: () => void;
  /** Called only when nothing is in flight — see `guardedCancel`. */
  onCancel: () => void;
}) {
  return (
    <ConfirmModal
      title={copy.title}
      body={
        <>
          {copy.body}
          {error && <span className="mt-2 block text-[#e53e3e]">{error}</span>}
        </>
      }
      confirmLabel={copy.confirmLabel}
      requireType={copy.requireType}
      danger
      pending={pending}
      onConfirm={onConfirm}
      onCancel={guardedCancel(pending, onCancel)}
    />
  );
}
