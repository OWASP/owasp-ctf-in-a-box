"use client";

// A worked request and response for each of the three module-wide AI
// endpoints, next to the URLs themselves.
//
// The per-challenge panel has always carried a ready-to-run curl for ONE
// route (`/api/ai/event`, signed with that challenge's real key). The other
// two were a URL and nothing else: an organizer could copy `/api/ai/submit`
// and still not know whether it wanted a header, what came back, or what a
// wrong flag looks like next to a refusal. These demos answer send / receive
// / expect for all three, in the shapes docs/ai-module.md §4–§8 specify.
//
// Every value here is a placeholder — `aik_…` for a key, `eyJ…` for a token.
// A challenge's REAL signing key stays on its own row, masked behind Reveal,
// and the one-click dry run stays Send test. These are for reading and
// adapting, which is why the Event demo computes its own signature rather
// than shipping a pre-signed one that would already be expired.

import CopyButton from "@/components/copy-button";

type DemoResponse = {
  status: string;
  body: string;
  meaning: string;
};

type EndpointDemo = {
  label: string;
  path: string;
  /** One line: why an integrator calls this at all. */
  purpose: string;
  /** The request, runnable once the placeholders are real. */
  request: (origin: string) => string;
  /** The happy path. */
  success: DemoResponse;
  /** The refusals worth designing for — not the whole error table (§7 is). */
  others: DemoResponse[];
};

export const ENDPOINT_DEMOS: EndpointDemo[] = [
  {
    label: "Submit",
    path: "/api/ai/submit",
    purpose: "Your site renders its own flag box and forwards what the player typed.",
    request: (origin) =>
      [
        `curl -sS -X POST ${origin}/api/ai/submit \\`,
        "  -H 'content-type: application/json' \\",
        `  -d '{"token":"eyJ…","flag":"CTF{what-the-player-typed}"}'`,
      ].join("\n"),
    success: {
      status: "200",
      body: '{"correct": true, "points": 400, "already": false}',
      meaning: "Fresh solve recorded. already: true means it was banked before — treat that as success too.",
    },
    others: [
      { status: "200", body: '{"correct": false}', meaning: "Wrong flag. Let them try again, subject to the cooldown." },
      {
        status: "429",
        body: '{"error": "cooldown", "retryAt": "…"}',
        meaning: "Too fast on this challenge. Wait until retryAt — flags only; a signed event is never throttled this way.",
      },
      {
        status: "409",
        body: '{"error": "wrong-mode"}',
        meaning: "This challenge is event-only. Report the solve through Event instead.",
      },
    ],
  },
  {
    label: "Event",
    path: "/api/ai/event",
    purpose: "Your backend decided the player solved it, and asserts that — signed.",
    request: (origin) =>
      [
        "KEY='aik_…'   # this challenge's signing key — Reveal it on its own row",
        "TOKEN='eyJ…'  # from the player's launch link",
        "TS=$(date +%s)",
        `BODY='{"token":"'"$TOKEN"'","challengeId":"prompt-armor","dryRun":true}'`,
        `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$KEY" -hex | awk '{print $NF}')`,
        `curl -sS -X POST ${origin}/api/ai/event \\`,
        "  -H 'content-type: application/json' \\",
        '  -H "X-CTF-Timestamp: $TS" -H "X-CTF-Signature: sha256=$SIG" \\',
        '  -d "$BODY"',
      ].join("\n"),
    success: {
      status: "200",
      body: '{"dryRun": true, "wouldAward": true, "verdict": "would-award", "checks": [...]}',
      meaning:
        'With dryRun: true nothing is written and no nonce is spent. Drop it for a real award: {"correct": true, "points": 400, "already": false}.',
    },
    others: [
      {
        status: "401",
        body: '{"error": "invalid-signature"}',
        meaning: "Almost always a re-serialized body rather than a wrong key — sign the exact bytes you send.",
      },
      {
        status: "401",
        body: '{"error": "stale-request"}',
        meaning: "X-CTF-Timestamp missing, non-numeric, or outside ±300s. Resync the clock and re-sign.",
      },
      {
        status: "409",
        body: '{"error": "replay"}',
        meaning: "This token's jti already produced a solve. A fresh launch link, not a retry.",
      },
    ],
  },
  {
    label: "State",
    path: "/api/ai/state",
    purpose: "Read live progress instead of trusting the token's mint-time snapshot.",
    request: (origin) =>
      [
        `curl -sS '${origin}/api/ai/state?t=eyJ…'`,
        "# or, if your stack would rather send a header:",
        `curl -sS ${origin}/api/ai/state -H 'Authorization: Bearer eyJ…'`,
      ].join("\n"),
    success: {
      status: "200",
      body: '{"sub": "alice", "points": 400,\n "progress": [{"id": "prompt-armor", "points": 400,\n               "solved": true, "solvedAt": "…"}]}',
      meaning:
        "Same per-entry shape as the token's ctf.progress — one parser does both. Answers Cache-Control: no-store; never cache it.",
    },
    others: [
      {
        status: "401",
        body: '{"error": "invalid-token"}',
        meaning: "Malformed, unverifiable, or the wrong audience. The player needs a fresh launch link.",
      },
      {
        status: "429",
        body: '{"error": "rate-limited"}',
        meaning: "120 requests/min per player here. Back off for the Retry-After seconds.",
      },
    ],
  },
];

/** Which routes can change a score. An organizer reading these should know
 *  that two of the three write and one cannot, before they try anything
 *  against a live event. */
export function writesState(label: string): boolean {
  return label !== "State";
}

/** One endpoint's worked example, collapsed. Native <details>, so the whole
 *  thing stays in the static markup and a test can read it without a click. */
export default function AiEndpointDemo({ demo, origin }: { demo: EndpointDemo; origin: string }) {
  const request = demo.request(origin);
  return (
    <details className="rounded-md border border-white/[0.06] bg-black/20 px-3 py-2">
      <summary className="cursor-pointer text-sm text-muted">
        {demo.label} — what to send and what comes back
        {!writesState(demo.label) && <span className="ml-2 text-xs text-[#22c55e]">read-only</span>}
      </summary>

      <div className="mt-2 flex flex-col gap-3">
        <p className="text-sm text-muted">{demo.purpose}</p>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wide text-muted">Send</span>
            <CopyButton value={request} label={`Copy ${demo.label} request`} />
          </div>
          <pre className="overflow-x-auto whitespace-pre rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-zinc-300">
            {request}
          </pre>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted">Receive</span>
          <pre className="overflow-x-auto whitespace-pre rounded-md border border-[#22c55e]/25 bg-black/40 px-3 py-2 font-mono text-xs text-zinc-300">
            {demo.success.status} {demo.success.body}
          </pre>
          <span className="text-sm text-muted">{demo.success.meaning}</span>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted">Also expect</span>
          <ul className="flex flex-col gap-1.5">
            {demo.others.map((other) => (
              <li key={`${other.status}${other.body}`} className="flex flex-col gap-0.5">
                <code className="font-mono text-xs text-zinc-300">
                  {other.status} {other.body}
                </code>
                <span className="text-sm text-muted">{other.meaning}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}
