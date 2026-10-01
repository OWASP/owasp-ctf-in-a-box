"use client";

// The Event tab's two image pickers (#529): the hero logo and the favicon.
// Self-contained on purpose — the images live in their own store, not in
// ctf:admin:settings, so this section owns its own GET and writes rather than
// threading them through admin-controls.tsx's settings state.
//
// A pick is sent at once; the server validates the decoded bytes and the
// preview then comes from our own versioned route. Nothing about the picked
// file itself ever reaches the DOM (the CodeQL js/xss-through-dom finding the
// sponsor dialog had to design around), and there is no unsaved draft state
// to lose. State and its guards live in event-images-model.ts's reducer.

import { useEffect, useReducer, useRef, useState } from "react";
import { EVENT_IMAGE_MIME_TYPES, EVENT_IMAGE_SLOTS, eventImageUrl, type EventImageMeta, type EventImageSlot, type EventImagesMeta } from "@/lib/event-images-keys";
import { fileToBase64 } from "./sponsor-editor-dialog";
import {
  canStart,
  describeStoredImage,
  imagesReducer,
  INITIAL_IMAGES_STATE,
  isPending,
  prepareUpload,
  SLOT_HELP,
  SLOT_LABEL,
} from "./event-images-model";

export type RowStatus = { state: "saving" | "saved" | "error"; message: string } | null;

const DEFAULT_LABEL: Record<EventImageSlot, string> = { logo: "Built-in OWASP mark", icon: "Built-in icon" };

export function EventImageRow({
  slot,
  stored,
  pending,
  status,
  onPick,
  onRestore,
}: {
  slot: EventImageSlot;
  stored: EventImageMeta | null;
  pending: boolean;
  status: RowStatus;
  onPick: (file: File) => void;
  onRestore: () => void;
}) {
  const label = SLOT_LABEL[slot];
  const helpId = `event-image-${slot}-help`;
  const statusId = `event-image-${slot}-status`;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-white">{label}</span>
      <div className="flex items-center gap-3">
        <div
          className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[#1a1a2e] ${slot === "logo" ? "h-16 w-40" : "h-16 w-16"}`}
        >
          {stored ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={eventImageUrl(slot, stored)} alt={`Current ${label.toLowerCase()}`} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="px-2 text-center text-[10px] uppercase tracking-wider text-[#d4a017]">{DEFAULT_LABEL[slot]}</span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label className="cursor-pointer self-start rounded-md border border-white/10 px-2.5 py-1 font-mono text-xs text-zinc-300 hover:border-[#2563eb]/45 hover:text-white">
            {stored ? `Replace ${label.toLowerCase()}…` : `Choose ${label.toLowerCase()}…`}
            <input
              type="file"
              accept={EVENT_IMAGE_MIME_TYPES[slot].join(",")}
              disabled={pending}
              aria-describedby={status ? `${helpId} ${statusId}` : helpId}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Clear the input so picking the same file again still fires.
                e.target.value = "";
                if (file) onPick(file);
              }}
              className="sr-only"
            />
          </label>
          <span className="truncate text-[11px] text-muted">{stored ? describeStoredImage(stored) : "Not set — the default is shown"}</span>
          {stored && (
            <button
              type="button"
              onClick={onRestore}
              disabled={pending}
              className="self-start font-mono text-[11px] text-zinc-400 underline hover:text-white disabled:opacity-50"
            >
              Restore default
            </button>
          )}
        </div>
      </div>
      <p id={helpId} className="text-xs text-muted">{SLOT_HELP[slot]}</p>
      {status && (
        <p
          id={statusId}
          role={status.state === "error" ? "alert" : "status"}
          className={`text-xs ${status.state === "error" ? "text-[#e53e3e]" : "text-muted"}`}
        >
          {status.message}
        </p>
      )}
    </div>
  );
}

async function decodedSize(file: File): Promise<{ w: number; h: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      return { w: bitmap.width, h: bitmap.height };
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${res.status}).`;
}

export default function AdminEventImages() {
  const [state, dispatch] = useReducer(imagesReducer, INITIAL_IMAGES_STATE);
  const [status, setStatus] = useState<Partial<Record<EventImageSlot, RowStatus>>>({});
  // The same per-slot guard as `state.busy`, read synchronously: two change
  // events in one tick both see the pre-render state, and only the first may
  // start (see imagesReducer for why one slot never runs two writes at once).
  const inFlight = useRef<Record<EventImageSlot, boolean>>({ logo: false, icon: false });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/event-images", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorOf(res));
        return (await res.json()) as { images: EventImagesMeta };
      })
      .then((body) => {
        if (!cancelled) dispatch({ type: "loaded", images: body.images });
      })
      .catch((err: unknown) => {
        if (!cancelled) dispatch({ type: "load-failed", message: err instanceof Error ? err.message : "Could not read the event images." });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const report = (slot: EventImageSlot, s: RowStatus) => setStatus((prev) => ({ ...prev, [slot]: s }));

  /** Runs one operation on one slot under that slot's guard, taken BEFORE
   *  anything async (validation included) and released only here. */
  async function guarded(slot: EventImageSlot, op: () => Promise<EventImageMeta | null | "refused">) {
    if (inFlight.current[slot] || !canStart(state, slot)) return;
    inFlight.current[slot] = true;
    dispatch({ type: "start", slot });
    let outcome: EventImageMeta | null | "refused" | "failed" = "failed";
    try {
      outcome = await op();
    } catch {
      report(slot, { state: "error", message: "Request failed — check the connection and try again." });
    } finally {
      inFlight.current[slot] = false;
      if (outcome === "refused" || outcome === "failed") dispatch({ type: "fail", slot });
      else dispatch({ type: "finish", slot, image: outcome });
    }
  }

  function pick(slot: EventImageSlot, file: File) {
    void guarded(slot, async () => {
      const refused = await prepareUpload(slot, file, () => decodedSize(file));
      if (refused) {
        report(slot, { state: "error", message: refused });
        return "refused";
      }
      report(slot, { state: "saving", message: "Uploading…" });
      const data = await fileToBase64(file);
      const res = await fetch("/api/admin/event-images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot, data, declaredType: file.type }),
      });
      if (!res.ok) {
        report(slot, { state: "error", message: await errorOf(res) });
        return "refused";
      }
      const body = (await res.json()) as { image: EventImageMeta };
      report(slot, { state: "saved", message: "Saved — shows on the next page load." });
      return body.image;
    });
  }

  function restore(slot: EventImageSlot) {
    void guarded(slot, async () => {
      report(slot, { state: "saving", message: "Restoring the default…" });
      const res = await fetch("/api/admin/event-images", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      if (!res.ok) {
        report(slot, { state: "error", message: await errorOf(res) });
        return "refused";
      }
      report(slot, { state: "saved", message: "Default restored." });
      return null;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {state.loadError && (
        <p role="alert" className="text-xs text-[#e53e3e]">
          Could not read the stored images: {state.loadError}
        </p>
      )}
      {EVENT_IMAGE_SLOTS.map((slot) => (
        <EventImageRow
          key={slot}
          slot={slot}
          stored={state.images[slot] ?? null}
          pending={isPending(state, slot)}
          status={status[slot] ?? null}
          onPick={(file) => pick(slot, file)}
          onRestore={() => restore(slot)}
        />
      ))}
    </div>
  );
}
