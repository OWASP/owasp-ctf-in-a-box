- **Added: optional Discord webhook announcements (#590).** `/admin` → Event
  now has a "Discord announcements" section: paste a discord.com webhook URL
  (stored in its own Redis key, never returned by any API, never logged, and
  audited only as "set"/"cleared") and opt each announcement in separately —
  first blood, event launch, scoring paused/resumed, and remaining-time
  checks at organizer-set marks — the time checks only while the event is
  live and unpaused, and never after the scoring window closes. Nothing
  posts by default: an observation loop reads its config first and ends the
  tick there for a box with no webhook or every announcement off (one
  pipeline carrying three reads, and the loop backs off to a much longer
  interval while the box stays unconfigured; a config/webhook save
  schedules an immediate pass without waiting for it. Enabling
  announcements shortly before launch announces the launch only when that
  pass records the pre-launch state first; a launch that starts before the
  pass runs is seeded silently),
  lifecycle edges go through an atomic compare-and-swap so exactly one
  replica announces each edge — and the first observation a box makes seeds
  silently, so configuring a webhook never replays history, while a freeze
  that spans a close and a window extension is announced once — first blood is
  recorded atomically at solve time and claimed when the post is enqueued (a
  box that is off never claims, so enabling later cannot replay it), and marks
  claim every crossed time in
  one pass while posting at most one check, so a restart or a mid-event
  enable never bursts. Delivery goes through a leased Redis outbox with
  retries — a restart loses nothing durable, and turning a type off stops
  its pending posts immediately. Every message suppresses Discord mentions
  outright, so a team named `@everyone` cannot ping the channel, and
  escapes Markdown in untrusted text, so a team named `[Claim your
  prize](…)` cannot become a clickable link; a classic challenge still
  locked behind its story step is never announced — not even its id; and no
  flag, answer or hint can reach a message, because the builders only
  accept public metadata. A Send test and per-type previews are in the
  section; the master reset wipes the announcement state but keeps the
  webhook setup (ADR 73).
