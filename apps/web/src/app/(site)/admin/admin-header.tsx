// The admin shell's compact header (admin-redesign.md PR 1): one row —
// `Admin · <event name> · <phase badge> · until <date>` — replacing the old
// three-line PageHeader (eyebrow "Organizer" / title "Admin" / a description
// that only ever said "Event controls and sync status.").
//
// The phase badge reuses the SAME vocabulary and colors the public phase
// strip already renders (registration/live/frozen/results — see
// `components/phase-line.tsx`), rather than inventing new phase names for
// the admin panel alone. `resolution` is null when settings couldn't be
// read (the same "Redis unreachable" case `page.tsx` already degrades for);
// the header still names the event, just with no phase to report.

import { PHASE_COLOR, phaseBoundaryLabel, type PhaseResolution } from "@/components/phase";

export default function AdminHeader({
  eventName,
  resolution,
}: {
  eventName: string;
  resolution: PhaseResolution | null;
}) {
  const boundary = resolution ? phaseBoundaryLabel(resolution.phase, resolution.startsAt, resolution.endsAt, resolution.timeZone) : null;
  const color = resolution ? PHASE_COLOR[resolution.phase] : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm font-semibold text-white">Admin</span>
      <span aria-hidden="true" className="text-zinc-600">
        ·
      </span>
      <span className="text-sm text-zinc-300">{eventName}</span>
      {resolution && color && (
        <>
          <span aria-hidden="true" className="text-zinc-600">
            ·
          </span>
          <span
            className="rounded-sm border px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider"
            style={{ color, borderColor: `${color}80`, background: `${color}1a` }}
          >
            {resolution.phase}
          </span>
        </>
      )}
      {boundary && (
        <>
          <span aria-hidden="true" className="text-zinc-600">
            ·
          </span>
          <span className="text-sm text-muted">{boundary}</span>
        </>
      )}
    </div>
  );
}
