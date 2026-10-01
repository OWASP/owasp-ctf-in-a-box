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
// to lose.

import { useEffect, useRef, useState } from "react";
import { EVENT_IMAGE_MIME_TYPES, EVENT_IMAGE_SLOTS, eventImageUrl, type EventImageMeta, type EventImageSlot, type EventImagesMeta } from "@/lib/event-images-keys";
import { fileToBase64 } from "./sponsor-editor-dialog";
import { describeStoredImage, prepareUpload, SLOT_HELP, SLOT_LABEL } from "./event-images-model";

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
  const [images, setImages] = useState<EventImagesMeta>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Partial<Record<EventImageSlot, RowStatus>>>({});
  const [busy, setBusy] = useState<EventImageSlot | null>(null);
  // Which write is the latest per slot: a slow, older one must not overwrite
  // the result of a newer one (the sponsor dialog's pickSeq, for the same race).
  const seq = useRef<Record<EventImageSlot, number>>({ logo: 0, icon: 0 });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/event-images", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorOf(res));
        return (await res.json()) as { images: EventImagesMeta };
      })
      .then((body) => {
        if (!cancelled) setImages(body.images);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not read the event images.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const report = (slot: EventImageSlot, s: RowStatus) => setStatus((prev) => ({ ...prev, [slot]: s }));

  async function pick(slot: EventImageSlot, file: File) {
    // Checks first, and only a file that passes them takes a sequence
    // number: a refused pick must not orphan a save already in flight.
    const refused = await prepareUpload(slot, file, () => decodedSize(file));
    if (refused) return report(slot, { state: "error", message: refused });
    const mine = ++seq.current[slot];

    setBusy(slot);
    report(slot, { state: "saving", message: "Uploading…" });
    try {
      const data = await fileToBase64(file);
      const res = await fetch("/api/admin/event-images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot, data, declaredType: file.type }),
      });
      if (mine !== seq.current[slot]) return;
      if (!res.ok) return report(slot, { state: "error", message: await errorOf(res) });
      const body = (await res.json()) as { image: EventImageMeta };
      setImages((prev) => ({ ...prev, [slot]: body.image }));
      report(slot, { state: "saved", message: "Saved — shows on the next page load." });
    } catch {
      if (mine === seq.current[slot]) report(slot, { state: "error", message: "Upload failed — check the connection and try again." });
    } finally {
      setBusy((b) => (b === slot ? null : b));
    }
  }

  async function restore(slot: EventImageSlot) {
    const mine = ++seq.current[slot];
    setBusy(slot);
    report(slot, { state: "saving", message: "Restoring the default…" });
    try {
      const res = await fetch("/api/admin/event-images", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      if (mine !== seq.current[slot]) return;
      if (!res.ok) return report(slot, { state: "error", message: await errorOf(res) });
      setImages((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      report(slot, { state: "saved", message: "Default restored." });
    } catch {
      if (mine === seq.current[slot]) report(slot, { state: "error", message: "Request failed — check the connection and try again." });
    } finally {
      setBusy((b) => (b === slot ? null : b));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {loadError && (
        <p role="alert" className="text-xs text-[#e53e3e]">
          Could not read the stored images: {loadError}
        </p>
      )}
      {EVENT_IMAGE_SLOTS.map((slot) => (
        <EventImageRow
          key={slot}
          slot={slot}
          stored={images[slot] ?? null}
          pending={busy === slot || loadError !== null}
          status={status[slot] ?? null}
          onPick={(file) => void pick(slot, file)}
          onRestore={() => void restore(slot)}
        />
      ))}
    </div>
  );
}
