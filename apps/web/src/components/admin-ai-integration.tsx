"use client";

// The per-challenge integration panel (spec §8.2), rendered by
// admin-ai-controls.tsx at the marked seam inside each challenge's row: the
// three module-wide endpoint URLs (with copy buttons), the challenge's
// signing key (masked by default, Reveal + copy, Rotate behind a
// consequences-confirm), a ready-to-run test curl, and the server-side
// "Send test" button.
//
// Split into a stateful default export and an exported, purely presentational
// `AiIntegrationPanel` — same shape as admin-ai-controls.tsx's
// `AdminAiControls`/`AiChallengeForm` split, for the same reason: this repo's
// component tests render with `renderToStaticMarkup` (vitest's `node`
// environment — no jsdom, no `@testing-library/react`), so no DOM event can
// ever be simulated. `AiIntegrationPanel` takes every bit of UI state
// (revealed, the rotate confirm's open/closed, the Send test result) as an
// explicit prop, so a test can render it directly in whichever state it wants
// to prove, without touching a button. The button-press LOGIC that a click
// would otherwise trigger — opening the rotate confirm, firing `onRotate` on
// confirm, running the Send test fetch — is pulled out as its own exported
// pure/async functions for the same reason `commitAiCooldown` exists in
// admin-ai-controls.tsx: provable by direct function call, no click required.
//
// Secrecy: the raw signing key is masked by literally never being referenced
// in the JSX tree while `revealed` is false — not a `type="password"` input
// (which still serializes its `value` attribute into SSR'd markup regardless
// of the input's `type`), but a placeholder STRING swapped in for the real
// one. `CopyButton` is the one place the raw key is always passed as a prop
// even while masked — that is fine: `CopyButton`'s own rendered output never
// echoes `value` into the DOM (see copy-button.tsx), it only closes over it
// inside the click handler, which `renderToStaticMarkup` never serializes.

import { useState, useSyncExternalStore } from "react";
import ConfirmModal from "@/components/confirm-modal";
import CopyButton from "@/components/copy-button";
import AiEndpointDemo, { ENDPOINT_DEMOS } from "@/components/admin-ai-endpoint-demos";
import type { AiChallenge } from "@/lib/ai-store";

export type AdminAiIntegrationProps = {
  challenge: AiChallenge;
  signingKey: string;
  onRotate: () => Promise<void>;
  pending: boolean;
};

/** Verbatim per spec §8.2 — the Rotate confirm's body. */
export const ROTATE_CONSEQUENCE = "The external system stops posting until you redeploy it with the new key.";

/** Verbatim per the brief — the caption under the test curl's TOKEN line. */
const TOKEN_CAPTION =
  "Use Send test below for a server-minted token, or copy a token from your own launcher link.";

const MASKED_KEY = "aik_…";

export type AiTestOutcome = { kind: "award" } | { kind: "named"; label: string };

/** Classifies a `/api/admin/ai/test` response into a render-ready outcome.
 *  `ok` is the HTTP-level `res.ok` of the admin route's OWN response — a
 *  non-ok response (400/429/503) carries its own `{error}` directly, never
 *  the `{status, body}` relay shape. A 200 carries `{status, body}`, where
 *  `body` is the REAL `/api/ai/event` handler's relayed JSON verbatim: either
 *  `{dryRun:true, wouldAward, verdict, checks}` or one of that handler's own
 *  refusal shapes (`{error:"wrong-mode"}`, etc). Exported so every shape the
 *  route can produce is provable by direct call — see this file's header
 *  comment for why no DOM event can drive this instead. */
export function classifyAiTestResponse(ok: boolean, data: unknown): AiTestOutcome {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (!ok) {
    return { kind: "named", label: typeof obj.error === "string" ? obj.error : "unavailable" };
  }
  const body = obj.body && typeof obj.body === "object" ? (obj.body as Record<string, unknown>) : {};
  if (body.wouldAward === true) return { kind: "award" };
  if (typeof body.verdict === "string") return { kind: "named", label: body.verdict };
  if (typeof body.error === "string") return { kind: "named", label: body.error };
  return { kind: "named", label: "unavailable" };
}

/** The actual network call, kept separate from the classifier above so a
 *  test can stub `global.fetch` and call this directly — proving both the
 *  exact request body (`{challengeId}`, nothing else) and the resulting
 *  outcome — with no DOM interaction at all. */
export async function fetchAiTest(challengeId: string): Promise<AiTestOutcome> {
  try {
    const res = await fetch("/api/admin/ai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId }),
    });
    const data = await res.json().catch(() => ({}));
    return classifyAiTestResponse(res.ok, data);
  } catch {
    return { kind: "named", label: "unavailable" };
  }
}

/** Which colour a Send test outcome earns (admin-redesign.md § Controls):
 *  green for a solve or a would-award — the integration works end to end —
 *  and red only for a refusal or a failure. Before this every named outcome
 *  was red, so "Test result: solved" read as an error. Exported for direct
 *  testing. */
export function testOutcomeTone(outcome: AiTestOutcome): "good" | "bad" {
  if (outcome.kind === "award") return "good";
  return outcome.label === "solved" || outcome.label === "would-award" ? "good" : "bad";
}

/** What a relayed verdict MEANS, in one sentence (audit F22).
 *
 *  The raw name stays on screen — `docs/operations.md` indexes these strings,
 *  and so does anyone searching an issue tracker — but the name alone sends an
 *  organizer to the docs mid-event to learn that `no-team` is not an
 *  integration fault at all: it means they personally are not on a team. The
 *  three that read like breakage and are not (`paused`, `solved`, `no-team`)
 *  are the whole reason this exists.
 *
 *  Deliberately silent for an unknown label. The route relays the event
 *  handler's verdict verbatim, so a newer handler can hand back a string this
 *  build has never seen; inventing an explanation for it would be worse than
 *  showing the name on its own. Exported for direct testing — `renderToStaticMarkup`
 *  cannot click Send test. */
export function testOutcomeHelp(label: string): string | null {
  switch (label) {
    case "paused":
      return "Not a fault: scoring is frozen, the event is outside its scheduled window, or it is not launched yet (no scoring start set). The dry run honours the schedule exactly as a real submission would.";
    case "solved":
      return "Not a fault: the signature and token were accepted, and your own login already holds this challenge.";
    case "no-team":
      return "Not a fault: the signature and token were accepted, but you are not on a team — the event route refuses a teamless login before awarding, organizers included.";
    case "unavailable":
      return "Redis could not be read, the request itself failed, or the AI module is switched off on the Event tab. Try again, or switch it back on.";
    case "wrong-mode":
      return "This challenge is flag-only, so it has no external event to report. Its mode changed after this panel loaded — refresh and re-check.";
    case "no-signing-key":
      return "This challenge has never had a signing key minted — a row from before signing keys existed. Click Rotate once to mint one.";
    default:
      return null;
  }
}

/** "Rotate" opens the confirm. It must never call `onRotate` directly — the
 *  confirm is the only gate between a click and a live integration breaking. */
export function requestRotate(setOpen: (v: boolean) => void): void {
  setOpen(true);
}

/** Confirming is the ONLY path that calls `onRotate`; the confirm closes once
 *  it resolves successfully. Exported (mirrors `commitAiCooldown` in
 *  admin-ai-controls.tsx) so the "does not fire until confirmed" contract is
 *  provable by direct call. A rejected `onRotate` leaves the confirm OPEN
 *  rather than closing it as if the rotate had succeeded — the caller
 *  (admin-ai-controls.tsx's `rotateSigningKey`) has already surfaced the
 *  error through its own error idiom before rejecting, so nothing here needs
 *  to inspect what went wrong. */
export async function confirmRotate(onRotate: () => Promise<void>, setOpen: (v: boolean) => void): Promise<void> {
  try {
    await onRotate();
    setOpen(false);
  } catch {
    // Left open deliberately — see the doc comment above.
  }
}

/** The spec §8.2 curl snippet, filled in with the real origin and challenge
 *  id. `KEY` interpolates the real signing key ONLY while `revealed` — masked,
 *  it shows the same `aik_…` placeholder the key display above it shows, so
 *  the raw key is absent from this block exactly when it is absent from the
 *  rest of the panel. `TOKEN` and `solvedAt` stay fixed placeholders — a
 *  real token is minted by Send test below, not by this static snippet. */
function testCurl(origin: string, challengeId: string, revealed: boolean, signingKey: string): string {
  const key = revealed ? signingKey : MASKED_KEY;
  return [
    `KEY='${key}'; TOKEN='eyJ…'`,
    "TS=$(date +%s)",
    `BODY='{"token":"'"$TOKEN"'","challengeId":"${challengeId}","solvedAt":"2026-08-31T12:00:00Z","dryRun":true}'`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$KEY" -hex | awk '{print $NF}')`,
    `curl -sS -X POST ${origin}/api/ai/event \\`,
    "  -H 'content-type: application/json' \\",
    '  -H "X-CTF-Timestamp: $TS" -H "X-CTF-Signature: sha256=$SIG" \\',
    '  -d "$BODY"',
  ].join("\n");
}

const noopSubscribe = () => () => {};

/** The browser's origin, hydration-safe: the server snapshot is "" and the
 *  browser's first render uses the same "" before React swaps in the real
 *  value, so the SSR markup and the hydrating render agree. Reading
 *  `window.location.origin` during render would make them disagree on every
 *  endpoint URL (CodeRabbit on #275). Shared by the endpoints block and the
 *  per-row panel so both agree on the origin. */
export function useBrowserOrigin(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );
}

/** The three module-wide endpoint URLs, with copy buttons. Rendered ONCE by
 *  admin-ai-controls.tsx above the challenge list — they are the same for
 *  every challenge, and rendering them inside every row printed them N×3
 *  times and made the list unscannable (UX audit F5). Presentational;
 *  `origin` is passed in for the same testability reason the panel's is. */
export function AiEndpointsBlock({ origin }: { origin: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-white/[0.06] bg-white/[0.015] px-3 py-3">
      <span className="text-sm text-white">Endpoints</span>
      <span className="text-sm text-muted">The same for every challenge — what the external site posts to and reads from.</span>
      <ul className="mt-1 flex flex-col gap-2">
        {ENDPOINT_DEMOS.map((demo) => {
          const url = `${origin}${demo.path}`;
          return (
            <li key={demo.path} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-sm text-zinc-300">
                  {url}
                </code>
                <CopyButton value={url} label={`Copy ${demo.label} URL`} />
              </div>
              {/* What to send, what comes back, what else to expect — the
                  per-row panel only ever demonstrated Event. */}
              <AiEndpointDemo demo={demo} origin={origin} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export type AiIntegrationPanelProps = {
  challenge: AiChallenge;
  signingKey: string;
  origin: string;
  pending: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
  rotateConfirmOpen: boolean;
  onRequestRotate: () => void;
  onCancelRotate: () => void;
  onConfirmRotate: () => void;
  testPending: boolean;
  testOutcome: AiTestOutcome | null;
  onSendTest: () => void;
};

/** Purely presentational — every bit of visual state is a prop. Exported so
 *  it can be rendered directly in whichever state a test wants to prove
 *  (masked/revealed, confirm open/closed, a specific Send test outcome)
 *  without simulating a click. See this file's header comment.
 *
 *  `challenge.mode` gates everything below Endpoints: a `mode: "flag"`
 *  challenge is graded only through `/api/ai/submit` (a typed flag) — the
 *  event route refuses it outright with `wrong-mode` (see ai-store.ts's
 *  AWARD_SCRIPT and the doc comment on `classifyAiTestResponse`'s handler),
 *  so the signing key, Rotate, the test curl, and Send test are all dead UI
 *  for it: nothing an organizer does with them changes how the challenge is
 *  graded. The three endpoint URLs stay live regardless — an external site
 *  still needs Submit/Event/State to embed a flag-mode challenge, since
 *  `/api/ai/submit` also runs through the same token this panel's URLs
 *  expose. */
export function AiIntegrationPanel({
  challenge,
  signingKey,
  origin,
  pending,
  revealed,
  onToggleReveal,
  rotateConfirmOpen,
  onRequestRotate,
  onCancelRotate,
  onConfirmRotate,
  testPending,
  testOutcome,
  onSendTest,
}: AiIntegrationPanelProps) {
  const flagOnly = challenge.mode === "flag";
  // Collapsed by default (UX audit F5): the integration plumbing is needed
  // once, while wiring the external site, and the list an organizer scrolls
  // to find a challenge should read as a list. The endpoint URLs are not
  // here at all any more — `AiEndpointsBlock` renders them once, above the
  // list. Native <details>, so the content stays in the static markup.
  return (
    <details className="rounded-md border border-white/[0.06] bg-white/[0.015] px-3 py-2">
      <summary className="cursor-pointer text-sm text-muted">
        {flagOnly
          ? "Integration — not needed for this challenge; it is graded by flag through the Submit endpoint"
          : "Integration — signing key, test curl, Send test"}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
      {flagOnly ? (
        <p className="text-sm text-muted">
          The signing key and Send test apply to event-mode challenges only — this challenge is graded solely
          through a typed flag submitted to the Submit endpoint listed above the challenge list.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-sm text-muted">
              Signing key
              <button type="button" onClick={onToggleReveal} className="ml-2 text-white hover:underline">
                {revealed ? "Hide" : "Reveal"}
              </button>
            </span>
            <div className="flex items-center gap-2">
              {/* The real key is referenced here ONLY while revealed — see the
                  file header comment on why this, and not `type="password"`, is
                  what actually keeps it out of the DOM while masked. */}
              <code className="min-w-0 flex-1 truncate rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-xs text-zinc-300">
                {revealed ? signingKey : MASKED_KEY}
              </code>
              <CopyButton value={signingKey} label="Copy signing key" />
            </div>
            {/* Amber, not red: rotating is recoverable (paste the new key
                into the external site) and sits behind a confirm; red is for
                what cannot be undone (redesign § Controls). */}
            <button
              type="button"
              disabled={pending}
              onClick={onRequestRotate}
              className="self-start rounded-md border border-[#d4a017]/50 px-2 py-1 text-sm text-[#d4a017] hover:bg-[#d4a017]/10 disabled:opacity-40"
            >
              Rotate
            </button>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-sm text-muted">Test curl (dry run)</span>
            <pre className="overflow-x-auto whitespace-pre rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-zinc-300">
              {testCurl(origin, challenge.id, revealed, signingKey)}
            </pre>
            <span className="text-sm text-muted">{TOKEN_CAPTION}</span>
          </div>

          <div className="flex flex-col gap-1">
            <button
              type="button"
              disabled={pending || testPending}
              onClick={onSendTest}
              className="self-start rounded-md border border-[#2563eb]/45 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/[0.06] disabled:opacity-50"
            >
              {testPending ? "Sending…" : "Send test"}
            </button>
            {testOutcome &&
              (testOutcome.kind === "award" ? (
                <p className="text-sm text-[#22c55e]">Would award — the dry run verified end to end.</p>
              ) : (
                <>
                  <p className={`text-sm ${testOutcomeTone(testOutcome) === "good" ? "text-[#22c55e]" : "text-[#e53e3e]"}`}>
                    Test result: {testOutcome.label}
                  </p>
                  {/* The name is what the docs and any issue thread call it;
                      the sentence is what it means here, now. */}
                  {testOutcomeHelp(testOutcome.label) && (
                    <p className="text-sm text-muted">{testOutcomeHelp(testOutcome.label)}</p>
                  )}
                </>
              ))}
          </div>

          {rotateConfirmOpen && (
            <ConfirmModal
              title="Rotate signing key?"
              body={ROTATE_CONSEQUENCE}
              confirmLabel="Rotate key"
              pending={pending}
              onConfirm={onConfirmRotate}
              onCancel={onCancelRotate}
            />
          )}
        </>
      )}
      </div>
    </details>
  );
}

export default function AdminAiIntegration({ challenge, signingKey, onRotate, pending }: AdminAiIntegrationProps) {
  const [revealed, setRevealed] = useState(false);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [testPending, setTestPending] = useState(false);
  const [testOutcome, setTestOutcome] = useState<AiTestOutcome | null>(null);

  // Hydration-safe (see `useBrowserOrigin`); this component's own tests
  // render `AiIntegrationPanel` directly with an explicit `origin`.
  const origin = useBrowserOrigin();

  async function sendTest() {
    setTestPending(true);
    setTestOutcome(null);
    const outcome = await fetchAiTest(challenge.id);
    setTestPending(false);
    setTestOutcome(outcome);
  }

  return (
    <AiIntegrationPanel
      challenge={challenge}
      signingKey={signingKey}
      origin={origin}
      pending={pending}
      revealed={revealed}
      onToggleReveal={() => setRevealed((v) => !v)}
      rotateConfirmOpen={rotateConfirmOpen}
      onRequestRotate={() => requestRotate(setRotateConfirmOpen)}
      onCancelRotate={() => {
        if (pending) return;
        setRotateConfirmOpen(false);
      }}
      onConfirmRotate={() => void confirmRotate(onRotate, setRotateConfirmOpen)}
      testPending={testPending}
      testOutcome={testOutcome}
      onSendTest={() => void sendTest()}
    />
  );
}
