// Reusable heading block for content routes: teal eyebrow, display title,
// optional lede, and the signature gradient divider. Server Component.

export default function PageHeader({
  eyebrow,
  title,
  description,
  logo,
}: {
  eyebrow: string;
  title: string;
  // ReactNode rather than string so a lede can carry an inline link — several
  // pages point at the Discord or a policy document from the header copy.
  description?: React.ReactNode;
  /** Shown beside the title, e.g. the event logo on the leaderboard (ADR 66).
   *  Absent, the header renders exactly as it always has. */
  logo?: React.ReactNode;
}) {
  const heading = (
    <h1 className="text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
      {title}
    </h1>
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-medium uppercase tracking-[0.25em] text-[#14b8a6]">
        {eyebrow}
      </p>
      {logo ? (
        // Wraps rather than overflows: on a phone a wide logo moves above the
        // title instead of pushing the row past the viewport.
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          {logo}
          {heading}
        </div>
      ) : (
        heading
      )}
      {description && (
        <p className="max-w-2xl text-base leading-relaxed text-zinc-400">
          {description}
        </p>
      )}
      <div className="mt-2 h-px w-full bg-gradient-to-r from-[#2563eb]/40 via-white/[0.06] to-transparent" />
    </div>
  );
}
