// A challenge's files, on its page (#186). An upload downloads through
// /api/attachments/<id>, which asks the challenge's own visibility again, so
// this list is only ever a convenience over a route that enforces the locks.
// A link points off-site and says so: it is as private as its URL, and no
// launch or story lock covers it. An upload still missing its bytes (named by
// an imported bundle, not re-uploaded yet) is not offered at all.

import { formatBytes } from "@/lib/attachments-keys";

export type AttachmentView =
  | { id: string; kind: "upload"; name: string; size: number; missing?: true }
  | { id: string; kind: "link"; name: string; url: string };

export default function AttachmentList({ items }: { items: readonly AttachmentView[] }) {
  const shown = items.filter((a) => a.kind === "link" || !a.missing);
  if (shown.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Files</span>
      <ul className="flex flex-col gap-1.5">
        {shown.map((a) => (
          <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            {a.kind === "upload" ? (
              <>
                <a
                  href={`/api/attachments/${a.id}`}
                  download
                  className="font-mono text-[#60a5fa] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
                >
                  {a.name}
                </a>
                <span className="text-xs text-muted">{formatBytes(a.size)}</span>
              </>
            ) : (
              <>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[#60a5fa] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d4a017]"
                >
                  {a.name}
                </a>
                <span className="text-xs text-muted">hosted externally</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
