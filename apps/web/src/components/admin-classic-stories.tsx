"use client";

// The /admin story editor (#463), below the category editor in the classic
// panel. A story is an ordered chain of challenges a team unlocks one step at
// a time; here an organizer names it, writes its intro, and picks and orders
// its steps with ↑ ↓ ✕ (no drag: a chain's order is the point, and buttons
// are exact and keyboard-operable).
//
// The whole list is one draft, saved with one POST of `{ stories }` — the
// route checks every step exists and `setStories` checks the rest (one story
// per challenge, caps, id grammar), so a refusal is shown here verbatim. The
// draft is seeded from `stories` and never re-synced from it while mounted:
// the panel remounts this component (by key) when the server's list changes.

import { useState } from "react";
import { type DescribeError, sendJson } from "@/components/admin/fetch";
import { INPUT_CLASS } from "@/components/admin/editor-fields";
import { describeClassicError } from "@/components/admin-classic-model";
import {
  addStep,
  addStory,
  freeChallengeIds,
  moveStep,
  pruneSteps,
  removeStep,
  removeStory,
  renameStory,
  setIntro,
} from "@/components/admin-classic-stories-model";
import type { Story } from "@/lib/story-lock";

const STEP_BUTTON =
  "rounded px-1.5 py-0.5 text-xs leading-none text-zinc-300 hover:bg-white/[0.08] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#d4a017] disabled:opacity-30 disabled:hover:bg-transparent";
const ACTION_BUTTON =
  "rounded-md border border-[#2563eb]/45 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/[0.06] disabled:opacity-50";

export default function AdminClassicStories({
  challenges,
  stories,
  loading = false,
  onSaved,
  describeError = describeClassicError,
}: {
  /** Every challenge on the board, in board order — step labels and the
   *  "Add step" options. */
  challenges: readonly { id: string; title: string }[];
  /** The stored list; seeds the draft. */
  stories: readonly Story[];
  /** True while the first read is still in flight. */
  loading?: boolean;
  /** The list the route stored, after a successful Save. */
  onSaved: (stories: Story[]) => void;
  describeError?: DescribeError;
}) {
  const existing = new Set(challenges.map((c) => c.id));
  const titleOf = new Map(challenges.map((c) => [c.id, c.title]));
  const [draft, setDraft] = useState<Story[]>(() => [...stories]);
  const [newTitle, setNewTitle] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Every view and every edit works on the PRUNED list: a challenge deleted
  // while this draft is open has already left its story in the store, so the
  // editor agrees with that and Save never POSTs a ghost step.
  const shown = pruneSteps(draft, existing);
  const free = freeChallengeIds(shown, challenges.map((c) => c.id));

  function edit(next: Story[]) {
    if (next === shown) return;
    setDraft(next);
    setDirty(true);
    setError(null);
  }

  async function save() {
    setPending(true);
    setError(null);
    const result = await sendJson<{ error?: string; stories?: Story[] }>(
      "/api/admin/classic",
      { method: "POST", body: { stories: shown } },
      describeError,
    );
    setPending(false);
    if (!result.ok) return setError(result.message);
    if (!Array.isArray(result.data.stories)) return setError(describeError(result.status, result.data.error));
    setDirty(false);
    onSaved(result.data.stories);
  }

  return (
    <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-white">Stories</span>
        <span className="text-sm text-muted">
          A chain of challenges each team unlocks in order: step 1 is open, each later step opens once the team
          solves the one before it. A challenge belongs to one story.
        </span>
      </div>
      {error && <p className="text-sm text-[#e53e3e]">{error}</p>}
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{loading ? "Checking…" : "No stories yet."}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {shown.map((st) => {
            const name = st.title || st.id;
            const pick = picks[st.id] && free.includes(picks[st.id]) ? picks[st.id] : (free[0] ?? "");
            return (
              <li key={st.id} className="flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.02] p-3">
                <div className="flex gap-2">
                  <input
                    value={st.title}
                    aria-label={`Title of story ${st.id}`}
                    disabled={pending}
                    onChange={(e) => edit(renameStory(shown, st.id, e.target.value))}
                    className={`flex-1 ${INPUT_CLASS}`}
                  />
                  <button type="button" disabled={pending} onClick={() => edit(removeStory(shown, st.id))} className={ACTION_BUTTON}>
                    Remove story
                  </button>
                </div>
                <textarea
                  value={st.intro}
                  aria-label={`Intro of ${name}`}
                  placeholder="Intro (optional) — shown above the story's steps"
                  rows={2}
                  disabled={pending}
                  onChange={(e) => edit(setIntro(shown, st.id, e.target.value))}
                  className={INPUT_CLASS}
                />
                {st.steps.length === 0 ? (
                  <p className="text-sm text-muted">No steps yet.</p>
                ) : (
                  <ol className="flex flex-col gap-1">
                    {st.steps.map((step, i) => {
                      const label = titleOf.get(step) ?? step;
                      return (
                        <li key={step} className="flex items-center gap-2 text-sm text-white">
                          <span className="w-6 text-right text-muted">{i + 1}.</span>
                          <span className="flex-1 truncate">{label}</span>
                          <button
                            type="button"
                            aria-label={`Move "${label}" up`}
                            disabled={pending || i === 0}
                            onClick={() => edit(moveStep(shown, st.id, i, -1))}
                            className={STEP_BUTTON}
                          >
                            <span aria-hidden="true">↑</span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Move "${label}" down`}
                            disabled={pending || i === st.steps.length - 1}
                            onClick={() => edit(moveStep(shown, st.id, i, 1))}
                            className={STEP_BUTTON}
                          >
                            <span aria-hidden="true">↓</span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove "${label}" from ${name}`}
                            disabled={pending}
                            onClick={() => edit(removeStep(shown, st.id, i))}
                            className={STEP_BUTTON}
                          >
                            <span aria-hidden="true">✕</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
                <div className="flex gap-2">
                  <select
                    value={pick}
                    aria-label={`Challenge to add to ${name}`}
                    disabled={pending || free.length === 0}
                    onChange={(e) => setPicks({ ...picks, [st.id]: e.target.value })}
                    className={`flex-1 ${INPUT_CLASS}`}
                  >
                    {free.length === 0 ? (
                      <option value="">Every challenge is in a story</option>
                    ) : (
                      free.map((id) => (
                        <option key={id} value={id}>
                          {titleOf.get(id) ?? id}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    type="button"
                    disabled={pending || !pick}
                    onClick={() => edit(addStep(shown, st.id, pick))}
                    className={ACTION_BUTTON}
                  >
                    Add step
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          value={newTitle}
          placeholder="New story title"
          disabled={pending}
          onChange={(e) => setNewTitle(e.target.value)}
          className={`flex-1 ${INPUT_CLASS}`}
        />
        <button
          type="button"
          disabled={pending || newTitle.trim().length === 0}
          onClick={() => {
            edit(addStory(shown, newTitle));
            setNewTitle("");
          }}
          className={ACTION_BUTTON}
        >
          New story
        </button>
        <button type="button" disabled={pending || !dirty} onClick={() => void save()} className={ACTION_BUTTON}>
          {pending ? "Saving…" : "Save stories"}
        </button>
      </div>
    </div>
  );
}
