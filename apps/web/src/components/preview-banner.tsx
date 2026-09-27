// Shown on every module page to an admin browsing BEFORE launch (#464): they
// see the board contestants will see, and their submissions are graded as dry
// runs — the same scripts, writing nothing. Rendered by each page from the
// access its own launch guard already resolved, so it costs no extra read.

import Link from "next/link";

export default function PreviewBanner() {
  return (
    <div
      role="status"
      className="ds-card flex flex-col gap-2 rounded-lg border border-[#d4a017]/30 bg-[#d4a017]/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-[#d4a017]">Preview — event not launched</p>
        <p className="mt-1 text-sm leading-relaxed text-zinc-300">
          Contestants see the landing page only. Your submissions here are graded but nothing is recorded.
        </p>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/" className="ds-link">
          View as contestant
        </Link>
        <Link href="/admin" className="ds-link">
          Launch in /admin
        </Link>
      </div>
    </div>
  );
}
