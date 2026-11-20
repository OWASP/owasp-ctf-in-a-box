// The two pieces of row furniture both leaderboard rows draw: the podium rank
// chip and the avatar. Shared rather than duplicated so a contestant row and a
// team row cannot drift apart on the one thing that makes them look like the
// same board.

import Image from "next/image";

// Podium accents for the top three, drawn from the design tokens.
const PODIUM: Record<number, string> = {
  1: "#d4a017", // gold
  2: "#a1a1aa", // silver
  3: "#14b8a6", // teal-bronze
};

/** The player's profile image, or their initial when they have none. Never a
 *  URL built from a name or an id: the profile image is the only source. */
export function Avatar({ name, image, size = 32 }: { name: string; image: string | null; size?: number }) {
  if (image) {
    return (
      <Image
        src={image}
        alt=""
        width={size}
        height={size}
        className="flex-none rounded-full border border-white/10"
        unoptimized
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex flex-none items-center justify-center rounded-full border border-white/10 bg-white/[0.06] font-mono uppercase text-zinc-300"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
    >
      {name.slice(0, 1)}
    </span>
  );
}

export function RankChip({ rank }: { rank: number }) {
  const podium = PODIUM[rank];
  return (
    <span
      className="flex h-10 w-10 flex-none items-center justify-center rounded-md font-display text-lg font-black tabular-nums"
      style={{
        color: podium ?? "#8f8f9b",
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: podium ? `${podium}66` : "rgba(255,255,255,0.08)",
        background: podium ? `${podium}14` : "transparent",
      }}
    >
      {rank}
    </span>
  );
}
