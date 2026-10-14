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
//      into mention syntax, as defence in depth for the rendered text, and
//      backslash-escapes Markdown (so a team named `[Claim your prize](…)`
//      cannot become a clickable link inside an official announcement) and
//      splits `https://` so Discord cannot autolink a URL out of untrusted
//      text.

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
  firstBlood: 0xe53e3e,
  launch: 0x22c55e,
  pause: 0xd4a017,
  resume: 0x22c55e,
  milestone: 0x2563eb,
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
 *  syntax neutralised (mass mentions and raw user/role/channel tokens),
 *  Markdown neutralised (masked links, bold, spoilers, inline code, quotes)
 *  and URLs unlinked (the `//` is split with a zero-width space, so Discord
 *  neither autolinks nor renders the target), then a length cap so one
 *  hostile field cannot blow past Discord's limits. The cap is applied AFTER
 *  the escapes (which add characters) and never splits a backslash escape in
 *  half, so a truncated escape cannot leave a stray `\` in the channel. */
export function escapeForDiscord(raw: string, maxLength = 120): string {
  let text = raw.replace(CONTROL_CHARS_RE, "").trim();
  text = text.replace(/@(everyone|here)/gi, `@${ZWSP}$1`);
  text = text.replace(/<(?=[@#&!])/g, `<${ZWSP}`);
  // Markdown and clickable links: a contestant-controlled team name must not
  // format the announcement or carry a phishing link under the event's
  // authority. Discord renders `\<special>` as the literal character.
  text = text.replace(/([\\*_~`|\[\]()>#-])/g, "\\$1");
  text = text.replace(/(https?):\/\//gi, `$1:${ZWSP}//`);
  if (text.length > maxLength) {
    text = text.slice(0, Math.max(0, maxLength - 1));
    // Never leave half an escape pair: a trailing lone `\` would swallow the
    // ellipsis into code-span-style nothingness.
    if (text.endsWith("\\")) text = text.slice(0, -1);
    text = `${text}…`;
  }
  return text;
}

/** Wraps one embed in the shape every message carries — mentions off,
 *  always. */
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

export type LifecycleKind = "launch" | "pause" | "resume" | "milestone";

export type LifecycleInput = { kind: LifecycleKind; eventName: string; timeLeft?: string };

const LIFECYCLE_COPY: Record<LifecycleKind, { title: string; color: number; description: (e: string) => string }> = {
  launch: { title: "The event is live!", color: COLOR.launch, description: (e) => `${e} has started. Good luck and have fun!` },
  pause: { title: "Scoring is paused", color: COLOR.pause, description: (e) => `Scoring for ${e} is paused — submits are on hold until it resumes.` },
  resume: { title: "Scoring resumed", color: COLOR.resume, description: (e) => `Scoring for ${e} is back on. Go get 'em.` },
  milestone: { title: "Time check", color: COLOR.milestone, description: (e) => `Time remaining in ${e}:`,
  },
};

/** Launch, pause/resume and the remaining-time check — one builder, the kind
 *  selecting the title, colour and copy. */
export function buildLifecycleMessage(input: LifecycleInput): DiscordMessage {
  const copy = LIFECYCLE_COPY[input.kind];
  const event = escapeForDiscord(input.eventName, 80);
  return msg({
    title: copy.title,
    color: copy.color,
    description: input.timeLeft ? `${copy.description(event)} **${escapeForDiscord(input.timeLeft, 40)}**` : copy.description(event),
  });
}
