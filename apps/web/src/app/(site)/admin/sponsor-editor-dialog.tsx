"use client";

// Add/Edit a sponsor, in a dialog rather than a form permanently parked above
// the list.
//
// The old form was always open and always empty-looking: "Edit" filled fields
// hundreds of pixels away from the row that was clicked, with nothing marking
// which row was being edited and no sign of the logo already on file — so
// replacing a logo meant uploading one to find out what the old one was. A
// dialog puts the form over the row it belongs to, shows the current logo, and
// leaves the list as the tab's main view.
//
// Owns the draft; hands the finished record to `onSubmit` and nothing else.
// The tab keeps the network call, so this stays renderable with no DOM.

import { useRef, useState } from "react";
import ModalDialog from "@/components/modal-dialog";
import {
  asSponsorLogoMime,
  SPONSOR_BLURB_MAX,
  SPONSOR_LOGO_MAX,
  SPONSOR_LOGO_MIME_TYPES,
  SPONSOR_NAME_MAX,
  type SponsorTier,
} from "@/lib/sponsors-keys";
import type { SponsorRecord } from "./sponsor-list";

export type SponsorDraft = {
  id: string;
  name: string;
  url: string;
  blurb: string;
  tier: SponsorTier;
  logoBase64?: string;
  logoType?: string;
  clearLogo?: boolean;
};

const FIELD_CLASS =
  "rounded-md border border-white/10 bg-[#1a1a2e] px-3 py-1.5 text-sm text-zinc-200 focus-visible:border-[#2563eb]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]";

/** How big the preview canvas may get. The preview exists to answer "is this
 *  the right image, and does it read on a dark panel" — it is never the
 *  stored asset, so a thumbnail's worth of pixels is the whole requirement. */
const PREVIEW_MAX_W = 256;
const PREVIEW_MAX_H = 128;

/** Renders the chosen file to a canvas and returns THAT canvas's data URL, or
 *  null if the bytes do not decode as an image.
 *
 *  The indirection is deliberate and is the fix for a CodeQL js/xss-through-dom
 *  finding (high) on two earlier shapes of this preview: both a hand-built
 *  `data:${file.type};base64,...` string and `URL.createObjectURL(file)` put a
 *  URL derived from an uploaded file straight into an `<img src>`. Here the
 *  src is produced by the canvas from pixels the browser already decoded, so
 *  nothing about the file's own bytes or its claimed type reaches the DOM.
 *
 *  Decoding is also the strictest check available on this side of the wire: a
 *  file the browser cannot decode as an image is one the store's magic-byte
 *  sniff would reject anyway, and saying so here costs no round trip. */
async function renderPreview(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, PREVIEW_MAX_W / bitmap.width, PREVIEW_MAX_H / bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // Always PNG: the preview keeps transparency so a logo with an alpha
      // channel is shown against the panel, which is the point of looking.
      return canvas.toDataURL("image/png");
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:<type>;base64," prefix FileReader.readAsDataURL adds.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function SponsorEditorDialog({
  sponsor,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  /** The row being edited, or null for a new sponsor. */
  sponsor: SponsorRecord | null;
  pending: boolean;
  /** The tab's last save error, rendered next to the button that caused it
   *  rather than on a panel-wide line behind the dialog. */
  error: string | null;
  onSubmit: (draft: SponsorDraft) => void;
  onCancel: () => void;
}) {
  const editing = sponsor !== null;
  const [draft, setDraft] = useState<SponsorDraft>({
    id: sponsor?.id ?? "",
    name: sponsor?.name ?? "",
    url: sponsor?.url ?? "",
    blurb: sponsor?.blurb ?? "",
    tier: sponsor?.tier ?? "community",
  });
  // A preview of the file just chosen — an organizer should see the logo
  // before saving it, not after reloading the tab. It is a canvas rendering
  // (see renderPreview), never a URL derived from the file itself. The base64
  // the POST needs is computed alongside it and never touches the DOM.
  const [pickedName, setPickedName] = useState<string | null>(null);
  const [pickedPreview, setPickedPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const hasStoredLogo = sponsor?.logo != null && draft.clearLogo !== true;
  const saveDisabled = pending || draft.name.trim() === "" || draft.url.trim() === "";

  async function onFileChange(file: File | null) {
    if (!file) return;
    setFileError(null);
    // Client-side pre-checks only — they mirror, but do not replace, the
    // store's own magic-byte sniff (sponsors-store.ts), which ignores the
    // claimed type entirely and reads the decoded bytes. These just save an
    // organizer a round trip on a file that was never going to be accepted.
    if (file.size > SPONSOR_LOGO_MAX) {
      setFileError(`Logo must be at most ${SPONSOR_LOGO_MAX} bytes — this file is ${file.size}.`);
      return;
    }
    const mime = asSponsorLogoMime(file.type);
    if (!mime) {
      setFileError(
        "Logo must be a PNG, JPEG or WebP image. SVG is rejected — it can run script when its URL is opened directly.",
      );
      return;
    }
    try {
      const [data, preview] = await Promise.all([fileToBase64(file), renderPreview(file)]);
      if (!preview) {
        setFileError("That file could not be decoded as an image — the box would refuse it too.");
        return;
      }
      setPickedName(file.name);
      setPickedPreview(preview);
      // `mime` is one of three literals from SPONSOR_LOGO_MIME_TYPES, not the
      // browser's string — the server ignores it either way, but nothing
      // downstream of here has to wonder what it might contain.
      setDraft((d) => ({ ...d, logoBase64: data, logoType: mime, clearLogo: undefined }));
    } catch {
      setFileError("Could not read that file — try choosing it again.");
    }
  }

  function clearPickedLogo() {
    setPickedName(null);
    setPickedPreview(null);
    setDraft((d) => ({ ...d, logoBase64: undefined, logoType: undefined }));
  }

  return (
    <ModalDialog
      title={editing ? `Edit ${sponsor.name}` : "Add sponsor"}
      pending={pending}
      onCancel={onCancel}
      initialFocusRef={nameRef}
      maxWidthClass="max-w-lg"
    >
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(draft);
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Name
          <input
            ref={nameRef}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            required
            maxLength={SPONSOR_NAME_MAX}
            className={FIELD_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          URL (https only)
          <input
            type="url"
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            required
            placeholder="https://example.com"
            className={FIELD_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Blurb (optional)
          <textarea
            value={draft.blurb}
            onChange={(e) => setDraft((d) => ({ ...d, blurb: e.target.value }))}
            maxLength={SPONSOR_BLURB_MAX}
            rows={2}
            className={FIELD_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Tier
          <select
            value={draft.tier}
            onChange={(e) => setDraft((d) => ({ ...d, tier: e.target.value as SponsorTier }))}
            className={`${FIELD_CLASS} w-40`}
          >
            <option value="gold">Gold</option>
            <option value="silver">Silver</option>
            <option value="community">Community</option>
          </select>
          <span className="text-[11px] text-muted">
            A label and a grouping on /sponsors — every sponsor appears on every surface regardless of tier. Position in
            the list is set with the arrows there, not here.
          </span>
        </label>

        <div className="flex flex-col gap-2 rounded-md border border-white/10 bg-[#12121e] p-3">
          <span className="text-xs text-zinc-400">Logo</span>
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-28 flex-none items-center justify-center overflow-hidden rounded border border-white/10 bg-[#1a1a2e] p-1">
              {pickedPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={pickedPreview} alt="Chosen logo preview" className="max-h-full max-w-full object-contain" />
              ) : hasStoredLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/sponsors/logo/${sponsor.id}`}
                  alt={`${sponsor.name} logo`}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="text-[10px] uppercase tracking-wider text-[#d4a017]">no logo</span>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label className="cursor-pointer self-start rounded-md border border-white/10 px-2.5 py-1 font-mono text-xs text-zinc-300 hover:border-[#2563eb]/45 hover:text-white">
                {hasStoredLogo || pickedPreview ? "Replace logo…" : "Choose logo…"}
                <input
                  type="file"
                  accept={SPONSOR_LOGO_MIME_TYPES.join(",")}
                  disabled={pending}
                  onChange={(e) => void onFileChange(e.target.files?.[0] ?? null)}
                  className="sr-only"
                />
              </label>
              <span className="truncate text-[11px] text-muted">
                {pickedName ?? (hasStoredLogo ? "Currently stored on this box" : "PNG, JPEG or WebP, up to 64KB")}
              </span>
              <div className="flex gap-3">
                {pickedPreview && (
                  <button
                    type="button"
                    onClick={clearPickedLogo}
                    className="self-start font-mono text-[11px] text-zinc-400 underline hover:text-white"
                  >
                    Undo this choice
                  </button>
                )}
                {/* Only offered where it can do something: a sponsor with no
                    stored logo has nothing to remove, and offering it anyway
                    was one of the old form's small lies. */}
                {editing && sponsor.logo != null && (
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <input
                      type="checkbox"
                      checked={draft.clearLogo === true}
                      onChange={(e) => {
                        const on = e.target.checked;
                        if (on) clearPickedLogo();
                        setDraft((d) => ({ ...d, clearLogo: on ? true : undefined }));
                      }}
                    />
                    Remove logo on save
                  </label>
                )}
              </div>
            </div>
          </div>
          {fileError && (
            <p role="alert" className="text-xs text-[#e53e3e]">
              {fileError}
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-[#e53e3e]">
            {error}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saveDisabled}
            className="rounded-md bg-[#2563eb] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Saving…" : editing ? "Save sponsor" : "Add sponsor"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
