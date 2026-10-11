"use client";

// The bulk import/export panel the quiz and classic admin panels render under
// their item list. Collapsed by default: an organizer authoring one item at a
// time shouldn't have to scroll past a bulk panel to reach the list. Note the
// `<details>` rather than a `{open && ...}` toggle — `<details>` renders its
// children into the markup regardless of whether it is open (the collapse is
// native browser behavior, not conditional React rendering), so this stays
// collapsible for an organizer AND fully present for a `renderToStaticMarkup`
// test.
//
// Presentational. State and the POST live in `useBundleImport`; the three
// sentences that differ between modules (what export downloads, the export
// button's label, the never-deletes notice) are props. So is the optional
// "Include files" checkbox, which only a module whose bundle can carry upload
// bytes passes; without `onIncludeFiles` the panel renders none.

import type { ChangeEvent, ReactNode } from "react";
import { formatBytes } from "@/lib/attachments-keys";
import { IMPORT_TEXTAREA_MAX, type ImportError } from "@/components/admin/use-bundle-import";

function ErrorList({ errors }: { errors: ImportError[] }) {
  return (
    <ul className="flex flex-col gap-1 text-sm text-[#e53e3e]">
      {errors.map((err, i) => (
        <li key={i}>
          {err.where}: {err.message}
        </li>
      ))}
    </ul>
  );
}

export default function ImportPanel({
  exportDescription,
  exportLabel,
  exportDisabled,
  onExport,
  exportPending = false,
  exportError = null,
  includeFiles = false,
  onIncludeFiles,
  notice,
  text,
  pending,
  clientErrors,
  importErrors,
  summary,
  canImport,
  onText,
  onFile,
  onSubmit,
}: {
  exportDescription: string;
  exportLabel: string;
  exportDisabled: boolean;
  onExport: () => void;
  /** An export that has to fetch first (the files) is in flight. */
  exportPending?: boolean;
  /** Why the last export could not be built, or null. */
  exportError?: string | null;
  /** The "Include files" checkbox: rendered only when `onIncludeFiles` is. */
  includeFiles?: boolean;
  onIncludeFiles?: (value: boolean) => void;
  /** THE notice a shorter file could otherwise be misread against — the
   *  client-side statement of the store's "import never deletes" guarantee. */
  notice: ReactNode;
  text: string;
  pending: boolean;
  clientErrors: ImportError[] | null;
  /** Everything that failed outside client-side validation — the import POST,
   *  or a file the browser could not read. */
  importErrors: ImportError[] | null;
  /** The formatted after-import line, or null. */
  summary: string | null;
  canImport: boolean;
  onText: (value: string) => void;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
}) {
  return (
    <details className="flex flex-col gap-3 border-t border-white/[0.06] pt-4">
      <summary className="cursor-pointer text-sm font-medium text-white">Bulk import / export</summary>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">{exportDescription}</span>
          <div className="flex flex-none items-center gap-3">
            {onIncludeFiles && (
              <label className="flex items-center gap-1.5 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={includeFiles}
                  disabled={exportPending}
                  onChange={(e) => onIncludeFiles(e.target.checked)}
                  className="accent-[#2563eb]"
                />
                Include files
              </label>
            )}
            <button
              type="button"
              disabled={exportDisabled || exportPending}
              onClick={onExport}
              className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04] disabled:opacity-40"
            >
              {exportPending ? "Exporting…" : exportLabel}
            </button>
          </div>
        </div>
        {exportError && <p className="text-sm text-[#e53e3e]">{exportError}</p>}

        <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
          <span className="text-sm text-white">Import a bundle</span>
          <p className="text-sm text-muted">{notice}</p>

          {text.length > IMPORT_TEXTAREA_MAX ? (
            // Too large to edit by hand, and a controlled textarea of it
            // freezes the tab — held, validated and sent as-is, described.
            <div className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-300">
              <span>Loaded a bundle of {formatBytes(text.length)} — too large to show here.</span>
              <button
                type="button"
                disabled={pending}
                onClick={() => onText("")}
                className="rounded-md border border-white/15 px-3 py-1 text-sm text-white hover:bg-white/[0.06] disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          ) : (
            <textarea
              value={text}
              disabled={pending}
              onChange={(e) => onText(e.target.value)}
              rows={6}
              placeholder="Paste a bundle's JSON here, or choose a file below."
              className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-xs text-white focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
            />
          )}

          <input type="file" accept=".json" disabled={pending} onChange={onFile} className="text-sm text-zinc-300" />

          {clientErrors && clientErrors.length > 0 && <ErrorList errors={clientErrors} />}

          {importErrors && importErrors.length > 0 && <ErrorList errors={importErrors} />}

          {summary && <p className="text-sm text-white">{summary}</p>}

          <button
            type="button"
            disabled={pending || !canImport}
            onClick={onSubmit}
            className="self-start rounded-md bg-[#2563eb] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Importing…" : "Import bundle"}
          </button>
        </div>
      </div>
    </details>
  );
}
