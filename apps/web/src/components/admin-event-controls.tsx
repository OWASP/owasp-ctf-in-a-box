"use client";

// Whole-EVENT archive export/import, rendered on the admin panel's Event tab
// alongside the freeze/schedule/reset controls (admin-controls.tsx). Mirrors
// the bulk import/export half of admin-classic-controls.tsx and
// admin-quiz-controls.tsx closely — same Blob-download export, same
// paste-or-upload textarea, same client-side-parse-gates-the-button import —
// with the differences this panel's own shape forces:
//
//   - There is no list this component owns and refreshes (no challenges, no
//     questions): it is a THIN client around GET/POST /api/admin/event (see
//     that route's header comment), which itself composes classic-store's and
//     quiz-store's own export/import. So there is no `initialChallenges`-style
//     seed for real data — only `initialImportText`, which exists purely so a
//     `renderToStaticMarkup` test can observe the import button's gated state
//     without a browser to paste into (see this component's test file header).
//   - The import is NOT an additive merge. Classic's and quiz's bundle imports
//     never delete anything already on the board; THIS import REPLACES both
//     modules' entire content AND wipes every team, solve, attempt, hint and
//     answer — `importEventBundle` (event-store.ts) runs the same
//     `resetEvent` the master reset button does before writing anything. That
//     is why this panel's copy says the opposite of the siblings' "import
//     never deletes" notice, and why the import path is gated behind a
//     DOUBLE confirmation rather than the siblings' single type-to-confirm:
//     first a plain warning naming exactly what gets replaced/wiped
//     (`importFirstWarning`), then a type-to-confirm phrase
//     (`importReplaceConfirm`) — the same `ConfirmModal` + `requireType`
//     pattern the master reset and the challenge/question deletes use,
//     applied twice because this single click is strictly more destructive
//     than either of those (it IS a master reset, plus a full content
//     replace, in one request). The server re-checks nothing about the
//     phrase — the gate is entirely a client-side speed bump against a
//     misclick, exactly like every other ConfirmModal in this panel; the
//     real backstop is the route's own live-event refusal (`EventLiveError`,
//     409) and needing `requireAdmin` at all.
//   - The route also refuses outright while the event is live (409), so a
//     destructive whole-event replace can never land on top of contestants
//     currently playing. That refusal surfaces here as an ordinary server
//     error via `describeEventError`, not a special client-side check —
//     duplicating the live check here would just be a second, staler answer
//     to the same question the server already re-asks on every POST.
//
// Client-safety: only value-imports from `@/lib/event-io`, which is
// deliberately client-safe (see its own header) for exactly this component's
// sake. `EventImportSummary` is imported `import type` from `event-store.ts`
// — that module starts with `import "server-only"`, but a type-only import is
// fully erased at compile time and never reaches the client bundle, the same
// pattern admin-classic-controls.tsx and admin-quiz-controls.tsx use for
// their own `server-only` stores' types. Never change either import to a
// value import.

import { useState, type ChangeEvent } from "react";
import { parseEventBundle, serializeEventBundle, type EventBundle, type EventImportError } from "@/lib/event-io";
import type { EventImportSummary } from "@/lib/event-store";
import ConfirmModal from "@/components/confirm-modal";
import { FILE_READ_ERROR } from "@/components/admin/use-bundle-import";

export type AdminEventControlsProps = {
  /** Test/first-paint seed only — lets a static-render test observe the
   *  import button's `canImport` gating (and the client-side validation
   *  errors under it) without a browser to paste into. Mirrors
   *  `initialChallenges`/`initialQuestions` on the sibling panels. Always ""
   *  in production; the textarea is otherwise empty on every real mount. */
  initialImportText?: string;
  /** When false, the internal "Event archive" heading + description are
   *  hidden — for embedding inside a disclosure whose summary already titles
   *  the section (the Event tab's danger zone). Defaults to true so the
   *  standalone/tested render is unchanged. */
  showHeading?: boolean;
};

/** Maps a `/api/admin/event` response to organizer-facing copy, distinguishing
 *  three failure shapes the route can produce: a validation failure (400 —
 *  the pasted/uploaded file was bad), a live-event refusal (409 —
 *  `EventLiveError`, see the route's header comment), and an infrastructure
 *  failure (503). Mirrors `describeClassicError`/`describeQuizError`, plus the
 *  409 case those two don't have. Exported for direct testing. */
export function describeEventError(status: number, message?: string): string {
  if (status === 409) {
    return message ?? "Refusing to import — the event is live. Pause scoring first.";
  }
  if (status === 503) {
    return message ? `Store unavailable — ${message}` : "Store unavailable — try again shortly.";
  }
  return message ?? "That didn't work — check the file and try again.";
}

/** The phrase the second confirmation step makes the organizer type. Not
 *  derived from anything about the bundle (there is no single title/prompt to
 *  echo, unlike a challenge/question delete) — a fixed, deliberately
 *  shouty phrase that reads as "this is not a normal action" on its own.
 *  Non-empty by construction, which is the whole guard: `ConfirmModal` treats
 *  an empty `requireType` as "no confirmation required" (see its own
 *  comment), and this constant can never become that by accident the way a
 *  derived-from-a-title phrase could (see `confirmPhraseFromTitle`'s comment
 *  on the classic panel for the failure mode this constant sidesteps by
 *  construction). */
export const IMPORT_CONFIRM_PHRASE = "REPLACE EVERYTHING";

/** Step one of the double confirmation: a plain warning, no typed phrase,
 *  naming exactly what a successful import does — replaces both modules'
 *  content and wipes every team/solve/attempt/hint/answer, the same reset
 *  the master reset performs. Exported for direct testing (see this file's
 *  test, and this component's own header comment on why the copy is proven
 *  through these pure builders rather than through a static render). */
export function importFirstWarning(): { title: string; body: string; confirmLabel: string } {
  return {
    title: "This import is destructive",
    body:
      "Importing this file REPLACES every Jeopardy challenge, every Quiz question and every AI challenge with what's in it, " +
      "and WIPES all teams, solves, attempts and answers — the same reset the master reset performs. " +
      "There is no undo. The next step asks you to type a confirmation phrase.",
    confirmLabel: "I understand, continue",
  };
}

/** Step two: the type-to-confirm gate itself. Exported for direct testing. */
export function importReplaceConfirm(): { title: string; body: string; requireType: string; confirmLabel: string } {
  return {
    title: "Replace ALL event content?",
    body:
      "This replaces every Jeopardy challenge, Quiz question and AI challenge with the file's content, and wipes all teams, " +
      "solves, attempts and answers. This cannot be undone.",
    requireType: IMPORT_CONFIRM_PHRASE,
    confirmLabel: "Replace everything",
  };
}

/** Formats an `EventImportSummary` into the panel's after-import message.
 *  Pure for the same reason `formatImportSummary` is pure on the sibling
 *  panels: `importResult` is `useState`, which `renderToStaticMarkup` can
 *  never reach, so the per-module presence/absence branching has to live
 *  outside a render tree to be exercised by a test at all.
 *
 *  Unlike the siblings, a module key is present in the summary only when that
 *  module's bundle was actually part of the import (`importEventBundle` only
 *  sets `summary.classic`/`summary.quiz` when `bundle.classic`/`bundle.quiz`
 *  was present — see event-store.ts) — a bundle that carried only a quiz
 *  section must not claim anything happened to Classic. Exported for direct
 *  testing. */
export function formatImportSummary(summary: EventImportSummary): string {
  const parts: string[] = [];
  if (summary.classic) {
    parts.push(`Jeopardy: ${summary.classic.created} created, ${summary.classic.updated} updated`);
  }
  if (summary.quiz) {
    parts.push(`Quiz: ${summary.quiz.created} created, ${summary.quiz.updated} updated`);
  }
  if (summary.ai) {
    parts.push(`AI: ${summary.ai.created} created, ${summary.ai.updated} updated`);
  }
  if (parts.length === 0) return "Imported — the bundle carried no modules.";
  return `Imported — ${parts.join("; ")}.`;
}

async function parseJson<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

/** The two-stage state a click on "Import bundle" walks through before the
 *  POST ever fires. `"idle"` is the resting state (and where a cancel at
 *  either later stage returns to); the state machine itself is what makes
 *  `submitImport` unreachable except by clicking through both `ConfirmModal`s
 *  in order. */
type ImportStage = "idle" | "warn" | "confirm";

export default function AdminEventControls({ initialImportText = "", showHeading = true }: AdminEventControlsProps = {}) {
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportWarnings, setExportWarnings] = useState<string[] | null>(null);

  const [importText, setImportText] = useState(initialImportText);
  const [importStage, setImportStage] = useState<ImportStage>("idle");
  const [importPending, setImportPending] = useState(false);
  const [importErrors, setImportErrors] = useState<EventImportError[] | null>(null);
  const [importResult, setImportResult] = useState<EventImportSummary | null>(null);
  const [importSkipped, setImportSkipped] = useState<string[] | null>(null);

  /** The export button's whole handler: fetch the current bundle + warnings
   *  from the server (unlike the siblings' export, this one DOES round-trip
   *  through the server — the bundle is assembled from live store state, not
   *  from anything this component already holds, since it holds no list),
   *  then hand the serialized bundle to the browser as a download exactly
   *  like the siblings. The object URL is revoked one tick after triggering
   *  the download, same reasoning as `handleExport` on both siblings: an
   *  un-revoked URL keeps the whole Blob pinned in memory for the page's
   *  life. */
  async function handleExport() {
    setExportPending(true);
    setExportError(null);
    try {
      const res = await fetch("/api/admin/event");
      const data = await parseJson<{ bundle?: EventBundle; warnings?: string[]; error?: string }>(res);
      if (!res.ok || !data.bundle) {
        setExportError(describeEventError(res.status, data.error));
        return;
      }
      setExportWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      const text = serializeEventBundle(data.bundle);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "event-bundle.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setExportError("Couldn't reach the server — try again.");
    } finally {
      setExportPending(false);
    }
  }

  /** Reads a chosen `.json` file client-side and drops its text into the same
   *  textarea the paste path uses, mirroring `handleFileChange` on both
   *  siblings exactly, including clearing the input's value afterward so
   *  re-choosing the same file still fires a change event. */
  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      // The caller `void`s this promise, so an uncaught rejection is silent:
      // the organizer is left looking at an unchanged textarea with no sign
      // the file never landed (#284 — the same fix as `useBundleImport`).
      // The stale success goes with it, or an unreadable file chosen after a
      // successful import would sit under that import's summary.
      setImportResult(null);
      setImportSkipped(null);
      setImportErrors([FILE_READ_ERROR]);
      return;
    }
    setImportText(text);
    setImportResult(null);
    setImportSkipped(null);
    setImportErrors(null);
  }

  /** The actual POST, reachable only once `importStage` has walked through
   *  both confirmations (see `ImportStage`'s comment). Sends the raw
   *  pasted/uploaded text exactly as the wire contract requires —
   *  `{ import: <raw text> }`, the ONLY key in the body — never a pre-parsed
   *  object; the route re-validates with the same `parseEventBundle` this
   *  component already ran client-side (see `validation` below), which is
   *  what makes it safe to accept text from a client whose own validation
   *  could in principle be skipped or stale. */
  async function submitImport() {
    setImportPending(true);
    setImportErrors(null);
    setImportResult(null);
    setImportSkipped(null);
    try {
      const res = await fetch("/api/admin/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ import: importText }),
      });
      const data = await parseJson<{
        errors?: EventImportError[];
        error?: string;
        summary?: EventImportSummary;
        skipped?: string[];
      }>(res);
      if (res.ok && data.summary) {
        setImportResult(data.summary);
        setImportSkipped(Array.isArray(data.skipped) ? data.skipped : []);
        setImportText("");
        return;
      }
      if (Array.isArray(data.errors)) {
        setImportErrors(data.errors);
        return;
      }
      setImportErrors([{ where: "(request)", message: describeEventError(res.status, data.error) }]);
    } catch {
      setImportErrors([{ where: "(request)", message: "Couldn't reach the server — try again." }]);
    } finally {
      setImportPending(false);
      setImportStage("idle");
    }
  }

  // Convenience only, run client-side before the button is even enabled — the
  // server re-validates the raw text regardless (see `submitImport`'s
  // comment), so this can never be the only gate. Skipped entirely on an
  // empty textarea, mirroring both siblings, so the panel doesn't greet an
  // organizer who hasn't pasted anything yet with a wall of "must be an
  // object" errors.
  const validation = importText.trim().length > 0 ? parseEventBundle(importText) : null;
  const clientErrors = validation && !validation.ok ? validation.errors : null;
  const canImport = validation !== null && validation.ok === true;

  const firstWarning = importFirstWarning();
  const replaceConfirm = importReplaceConfirm();

  return (
    <div className="flex flex-col gap-4">
      {showHeading && (
        <>
          <h3 className="text-sm font-semibold text-white">Event archive</h3>
          <p className="text-sm text-muted">
            Export the whole event — Jeopardy, Quiz and AI content plus event policy settings — as one JSON file, or
            replace it wholesale from a previously exported file.
          </p>
        </>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-white">Export</span>
          <button
            type="button"
            disabled={exportPending}
            onClick={() => void handleExport()}
            className="rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04] disabled:opacity-40"
          >
            {exportPending ? "Exporting…" : "Export event"}
          </button>
        </div>
        {exportError && <p className="text-sm text-[#e53e3e]">{exportError}</p>}
        {exportWarnings && exportWarnings.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-[#d4a017]/40 bg-[#d4a017]/10 px-3 py-2 text-sm text-[#d4a017]">
            {exportWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
        <span className="text-sm text-white">Import a bundle (replaces everything)</span>
        {/* The opposite of the siblings' "import never deletes" notice — see
            this component's header comment for why. */}
        <p className="text-sm text-muted">
          This REPLACES every Jeopardy challenge, Quiz question and AI challenge with the file&rsquo;s content, and
          wipes all teams, solves, attempts and answers. Refused outright while the event is live.
        </p>

        <textarea
          value={importText}
          disabled={importPending}
          onChange={(e) => {
            setImportText(e.target.value);
            setImportResult(null);
            setImportSkipped(null);
            setImportErrors(null);
          }}
          rows={6}
          placeholder="Paste an event bundle's JSON here, or choose a file below."
          className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-xs text-white focus-visible:border-[#d4a017]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
        />

        <input
          type="file"
          accept=".json"
          disabled={importPending}
          onChange={(e) => void handleFileChange(e)}
          className="text-sm text-zinc-300"
        />

        {clientErrors && clientErrors.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-[#e53e3e]">
            {clientErrors.map((err, i) => (
              <li key={i}>
                {err.where}: {err.message}
              </li>
            ))}
          </ul>
        )}

        {importErrors && importErrors.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-[#e53e3e]">
            {importErrors.map((err, i) => (
              <li key={i}>
                {err.where}: {err.message}
              </li>
            ))}
          </ul>
        )}

        {importResult && <p className="text-sm text-white">{formatImportSummary(importResult)}</p>}
        {importSkipped && importSkipped.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-muted">
            {importSkipped.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
        {importResult && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="self-start rounded-md border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04]"
          >
            Reload page
          </button>
        )}

        <button
          type="button"
          disabled={importPending || !canImport}
          onClick={() => setImportStage("warn")}
          className="self-start rounded-md bg-[#e53e3e] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#c53030] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {importPending ? "Importing…" : "Import bundle"}
        </button>
      </div>

      {importStage === "warn" && (
        <ConfirmModal
          title={firstWarning.title}
          body={firstWarning.body}
          confirmLabel={firstWarning.confirmLabel}
          danger
          onConfirm={() => setImportStage("confirm")}
          onCancel={() => setImportStage("idle")}
        />
      )}

      {importStage === "confirm" && (
        <ConfirmModal
          title={replaceConfirm.title}
          body={replaceConfirm.body}
          confirmLabel={replaceConfirm.confirmLabel}
          requireType={replaceConfirm.requireType}
          danger
          pending={importPending}
          onConfirm={() => void submitImport()}
          onCancel={() => {
            if (importPending) return;
            setImportStage("idle");
          }}
        />
      )}
    </div>
  );
}
