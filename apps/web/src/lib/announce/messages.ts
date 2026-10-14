// Discord message builders (#590). Pure and dependency-free: every
// announcement — live posts, admin previews, the Send test — is built by the
// functions here, so a preview is byte-identical to what the announcer would
// post for the same input.
//
// Two invariants are structural, not convention:
//
//   1. A builder's INPUT TYPE carries only public metadata — a title, a
//      category, points, a team name, a link. There is no field a flag, an
//      answer, a hint or a locked story step's internals could ride in on,
//      so none can leak by a caller's mistake.
//   2. Every message sets `allowed_mentions: { parse: [] }`, so Discord
//      resolves NO mentions in it — a team named "@everyone" cannot ping the
//      channel. `escapeForDiscord` additionally inserts a zero-width space
//      into mention syntax, as defence in depth for the rendered text.

export type DiscordEmbed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
};

export type DiscordMessage = {
  content?: string;
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: [] };
};

const COLOR = {
  release: 0x2563eb,
  firstBlood: 0xe53e3e,
  leader: 0xd4a017,
  launch: 0x22c55e,
  pause: 0xd4a017,
  resume: 0x22c55e,
  registration: 0x2563eb,
  milestone: 0x2563eb,
  daily: 0x2563eb,
  test: 0x7c3aed,
} as const;

// C0/C1 control characters and the bidi overrides — the same rendered-text
// integrity rule the module-title field applies (admin-store.ts). A team name
// or challenge title with a smuggled line break or terminal escape must not
// reach the channel.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;
// Zero-width space: what "@everyone" becomes "@​everyone" — Discord renders
// it almost identically and never resolves it as a mention.
const ZWSP = "​";

/** Scrubs text destined for the channel: control characters out, mention
 *  syntax neutralised (mass mentions and raw user/role/channel tokens), and
 *  a length cap so one hostile field cannot blow past Discord's limits. */
export function escapeForDiscord(raw: string, maxLength = 120): string {
  let text = raw.replace(CONTROL_CHARS_RE, "").trim();
  text = text.replace(/@(everyone|here)/gi, `@${ZWSP}$1`);
  text = text.replace(/<(?=[@#&!])/g, `<${ZWSP}`);
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text;
}

function msg(embed: DiscordEmbed): DiscordMessage {
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}

/** The Send test / its preview — built from the event's name only. */
export function buildTestMessage(eventName: string): DiscordMessage {
  return msg({
    title: "Test announcement",
    description: `${escapeForDiscord(eventName, 80)} → this channel. Announcements configured in /admin → Event will post here.`,
    color: COLOR.test,
  });
}

export type ReleaseInput = { title: string; category: string; points: number; url: string };

/** A challenge released: only ever called for a challenge that is actually
 *  public (see announce/ticker's release sweep). Never for a locked story
 *  step — that is filtered before the builder is reached. */
export function buildReleaseMessage(input: ReleaseInput): DiscordMessage {
  // The cap is applied to the WHOLE description, suffix included, so one
  // hostile title cannot push the rendered line past the length the escape
  // layer promises.
  const suffix = ` — **${input.points} pts**`;
  const title = escapeForDiscord(input.title, Math.max(1, 120 - suffix.length));
  return msg({
    title: "New challenge released",
    url: input.url,
    color: COLOR.release,
    description: `${title}${suffix}`,
    fields: [{ name: "Category", value: escapeForDiscord(input.category || "—"), inline: true }],
  });
}

export type FirstBloodInput = { challengeTitle: string; points: number; who: string; url: string };

/** First blood: the first TEAM (or solo login) to solve a challenge. */
export function buildFirstBloodMessage(input: FirstBloodInput): DiscordMessage {
  return msg({
    title: "🩸 First blood",
    url: input.url,
    color: COLOR.firstBlood,
    description: `**${escapeForDiscord(input.who)}** solved **${escapeForDiscord(input.challengeTitle)}** first!`,
    fields: [{ name: "Points", value: String(input.points), inline: true }],
  });
}

export type LeaderInput = {
  scope: "first" | "top3";
  leader: { name: string; points: number };
  runnersUp?: { name: string; points: number }[];
};

/** A leaderboard change: a new #1, or (scope "top3") any change among the
 *  top three. Names are team display names, already escaped. */
export function buildLeaderMessage(input: LeaderInput): DiscordMessage {
  const fields = [{ name: "New #1", value: `${escapeForDiscord(input.leader.name)} — ${input.leader.points} pts`, inline: false }];
  if (input.scope === "top3" && input.runnersUp?.length) {
    fields.push({
      name: "Top three",
      value: input.runnersUp
        .map((t, i) => `${i + 2}. ${escapeForDiscord(t.name)} — ${t.points} pts`)
        .join("\n"),
      inline: false,
    });
  }
  return msg({ title: "Leaderboard change", color: COLOR.leader, fields });
}

export type LifecycleKind = "launch" | "pause" | "resume" | "registration-closed" | "milestone";

export type LifecycleInput = { kind: LifecycleKind; eventName: string; timeLeft?: string };

const LIFECYCLE_COPY: Record<LifecycleKind, { title: string; color: number; description: (e: string) => string }> = {
  launch: { title: "The event is live!", color: COLOR.launch, description: (e) => `${e} has started. Good luck and have fun!` },
  pause: { title: "Scoring is paused", color: COLOR.pause, description: (e) => `Scoring for ${e} is paused — submits are on hold until it resumes.` },
  resume: { title: "Scoring resumed", color: COLOR.resume, description: (e) => `Scoring for ${e} is back on. Go get 'em.` },
  "registration-closed": {
    title: "Team registration is closed",
    color: COLOR.registration,
    description: (e) => `Team registration for ${e} is now closed. Existing teams keep playing.`,
  },
  milestone: { title: "Time check", color: COLOR.milestone, description: (e) => `Time remaining in ${e}:`,
  },
};

export function buildLifecycleMessage(input: LifecycleInput): DiscordMessage {
  const copy = LIFECYCLE_COPY[input.kind];
  const event = escapeForDiscord(input.eventName, 80);
  return msg({
    title: copy.title,
    color: copy.color,
    description: input.timeLeft ? `${copy.description(event)} **${escapeForDiscord(input.timeLeft, 40)}**` : copy.description(event),
  });
}

export type DailyInput = {
  /** The event-local calendar day, e.g. "Oct 14". */
  day: string;
  topTeams: { name: string; points: number }[];
  solves: number;
  releases: number;
  timeLeft: string | null;
};

export function buildDailyMessage(input: DailyInput): DiscordMessage {
  const board =
    input.topTeams.length > 0
      ? input.topTeams.map((t, i) => `${i + 1}. ${escapeForDiscord(t.name)} — ${t.points} pts`).join("\n")
      : "No teams on the board yet.";
  return msg({
    title: `Daily summary — ${escapeForDiscord(input.day, 40)}`,
    color: COLOR.daily,
    description: board,
    fields: [
      { name: "Solves today", value: String(input.solves), inline: true },
      { name: "Challenges released", value: String(input.releases), inline: true },
      { name: "Time remaining", value: input.timeLeft ? escapeForDiscord(input.timeLeft, 40) : "—", inline: true },
    ],
  });
}
