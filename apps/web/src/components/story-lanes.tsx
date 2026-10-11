// Stories (#463): one lane per story, above the category grid, its steps in
// order. An OPEN step is a normal tile (with its category as a tag); a LOCKED
// step is a placeholder — "??? — step N of M", no link, and nothing about the
// challenge itself (the view model never even carries it: see flags/page.tsx).

import Link from "next/link";
import { teamsLabel } from "@/components/challenge-detail";

export type StoryStepView =
  | { locked: true; key: string; label: string }
  | {
      locked: false;
      id: string;
      title: string;
      category: string;
      points: number;
      solved: boolean;
      position: number;
      total: number;
      /** Teams that solved it (#595); null when unread. A locked step has
       *  no count at all: it is invisible (ADR 60). */
      teamsSolved: number | null;
    };

export type StoryLaneView = { id: string; title: string; intro: string; steps: StoryStepView[] };

export default function StoryLanes({ stories, basePath }: { stories: StoryLaneView[]; basePath: string }) {
  if (stories.length === 0) return null;
  return (
    <section aria-label="Stories" className="flex flex-col gap-6">
      {stories.map((story) => (
        <section key={story.id} className="flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">{story.title}</h2>
            {story.intro && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-400">{story.intro}</p>}
          </div>
          <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {story.steps.map((step) =>
              step.locked ? (
                <li key={step.key}>
                  <div
                    aria-label={`${step.label}, locked`}
                    className="ds-card flex h-full min-h-24 flex-col justify-between gap-2 rounded-lg border border-dashed border-white/[0.1] bg-[#12121e] p-4 text-sm text-muted"
                  >
                    <span aria-hidden>🔒</span>
                    <span className="font-mono text-xs">{step.label}</span>
                  </div>
                </li>
              ) : (
                <li key={step.id}>
                  <Link
                    href={`${basePath}/${encodeURIComponent(step.id)}`}
                    aria-label={`Step ${step.position} of ${step.total}: ${step.title}, ${step.points} points${step.solved ? ", solved" : ""}`}
                    className={`ds-card flex h-full min-h-24 flex-col justify-between gap-2 rounded-lg border p-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017] ${
                      step.solved ? "border-[#22c55e]/40 bg-[#22c55e]/[0.08]" : "border-white/[0.06] bg-[#16162a] hover:border-[#2563eb]/40"
                    }`}
                  >
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                      Step {step.position} · {step.category}
                    </span>
                    <span className={`line-clamp-2 text-sm font-medium ${step.solved ? "text-[#22c55e]" : "text-white"}`}>{step.title}</span>
                    <span className={`font-mono text-xs tabular-nums ${step.solved ? "text-[#22c55e]/80" : "text-muted"}`}>
                      {step.points} pts{step.teamsSolved !== null && <> · {teamsLabel(step.teamsSolved)}</>}
                      {step.solved && " ✓"}
                    </span>
                  </Link>
                </li>
              ),
            )}
          </ol>
        </section>
      ))}
    </section>
  );
}
