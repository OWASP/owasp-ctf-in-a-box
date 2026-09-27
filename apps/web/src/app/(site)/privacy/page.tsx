// Privacy notice for this site specifically. The OWASP Foundation privacy
// policy is the governing document; this page exists because it can't describe
// what a one-off CTF site does with GitHub logins and hint purchases.
//
// IMPORTANT: every claim here is a promise about code in this repo. If you
// change what is stored, what a cookie holds, or how long anything is kept,
// change this page in the SAME PR. Sources for the claims below:
//   src/lib/auth.ts .................. sessions, OAuth scopes, no token storage
//   src/lib/stats-store.ts ........... aggregate country counters
//   src/lib/hint-store.ts ............ hint purchases
//   src/lib/team-store.ts ............ team membership
//   src/lib/quiz-store.ts ............ quiz answers and points
//   src/lib/classic-store.ts ......... classic flag solves, attempts, points
//   src/lib/activity-log.ts .......... organizer activity log (sign-ins, solves, team changes)
//
// Tone note: this page reads as reassuring because the underlying design
// genuinely is careful — not the other way round. Don't add warmth here that
// the code doesn't earn.
//
// The page is PLATFORM copy — it describes this codebase, not a module's game
// — but which stores are live is per-event: hint purchases exist only where
// secure-development runs, quiz answers only where the quiz does, classic
// solves/attempts only where classic does. So the module-specific claims are
// gated on the modules being enabled rather than contributed from the
// registry. That keeps this an honest inventory of what is actually stored: a
// quiz-only (or classic-only) event neither promises a per-challenge
// breakdown it doesn't have, nor stays silent about the answers/solves it
// does keep.

import type { Metadata } from "next";
import Link from "next/link";
import PageHeader from "@/components/page-header";
import { getEnabledModuleIds } from "@/lib/enabled-modules";
import { getSite } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const event = await getSite();
  return {
    title: "Privacy",
    description:
      `What the ${event.name} site collects, where it's stored, who can see it, and how to ask for it to be deleted.`,
  };
}

const ExternalLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="ds-link">
    {children}
  </a>
);

const Card = ({ heading, children }: { heading: string; children: React.ReactNode }) => (
  <section className="rounded-lg border border-white/[0.06] bg-[#16162a] p-6">
    <h2 className="mb-4 text-lg font-semibold text-white">{heading}</h2>
    {children}
  </section>
);

const Bullets = ({ items, accent = "#2563eb" }: { items: React.ReactNode[]; accent?: string }) => (
  <ul className="flex flex-col gap-3">
    {items.map((item, i) => (
      <li key={i} className="flex gap-3 text-sm leading-relaxed text-zinc-400">
        <span className="mt-2 h-1.5 w-1.5 flex-none rounded-full" style={{ background: accent }} />
        <span>{item}</span>
      </li>
    ))}
  </ul>
);

// The strongest thing this page can say is what never happens at all. Every
// line here is enforced by code, not policy — check before adding to it.
//
// This is a FUNCTION of `secureDev`, not a module-scope constant:
// secure-development is runtime-toggleable now (issue #386), so there is no
// longer a module-load-time answer for whether it is live — only a
// per-request one, read inside the page component.
function neverLines(secureDev: boolean): string[] {
  return [
    "No advertising, no tracking pixels, no third-party analytics, no data broker. Nothing about you is sold or shared.",
    "No consent banner, because there is nothing to consent to. Every cookie we set is doing a job you asked for.",
    "Your email address and your real name are never written to our databases and never appear anywhere on this site.",
    // Same promise either way; it just can't be made concrete with artifacts
    // an event without secure-development has no notion of.
    secureDev
      ? "We never ask GitHub for write access. We cannot push code, open pull requests, change your repositories, or act as you."
      : "We never ask GitHub for write access. The scopes we ask for are read-only, so we cannot write anything to your GitHub account or act as you.",
    "We don't keep the GitHub access token issued at sign-in, so there is no key to your GitHub account sitting in our systems.",
    "We don't build a location history. The only geographic data we hold is a per-country tally with nobody's name on it.",
  ];
}

function cookieRows(): { name: string; what: string; life: string }[] {
  return [
    {
      name: "Sign-in session",
      what: "Set when you sign in with GitHub, and holds your session. Encrypted, and readable only by the server. Your browser can't read it, and neither can any script on the page.",
      life: "7 days",
    },
    {
      name: "Sign-in handshake",
      what: "Protects the GitHub sign-in redirect against tampering. Discarded the moment sign-in finishes.",
      life: "10 minutes",
    },
    {
      name: "ctf-mock-team",
      what: "Only in the pre-event demo mode, to remember a team choice locally when nothing is being written server-side.",
      life: "30 days",
    },
  ];
}

export default async function PrivacyPage() {
  const event = await getSite();
  const liveModules = await getEnabledModuleIds();
  // secure-development, quiz and classic are ALL runtime-toggleable now
  // (issue #386) — this page's claims about what is collected have to match
  // what actually is, so all three are read off the one live-set read below,
  // per request.
  const secureDev = liveModules.has("secure-development");
  const quiz = liveModules.has("quiz");
  const classic = liveModules.has("classic");
  const NEVER = neverLines(secureDev);
  const cookies = cookieRows();

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        eyebrow="Privacy"
        title="Privacy notice"
        description="A security event should be able to explain exactly what it does with your data. This page does that: written against the code, in plain language, with the awkward parts left in."
      />

      <section className="rounded-lg border border-[#22c55e]/25 bg-[#22c55e]/[0.05] p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">What we never do</h2>
        <Bullets items={NEVER} accent="#22c55e" />
      </section>

      <section className="rounded-lg border border-white/[0.06] bg-[#16162a] p-6">
        <p className="text-sm leading-relaxed text-zinc-400">
          The OWASP Foundation&apos;s{" "}
          <ExternalLink href={event.owaspPrivacyUrl}>Privacy Policy</ExternalLink> is the
          governing document and covers OWASP as a whole. This page is narrower and more
          specific: it describes what{" "}
          <span className="text-white">this competition site</span>{" "}
          does, because a general policy can&apos;t tell you what happens to{" "}
          {secureDev ? "a hint purchase or a GitHub login" : "a GitHub login"} on a leaderboard.
        </p>
      </section>

      <Card heading="Most of this site needs nothing from you">
        <Bullets
          items={
            secureDev
              ? [
                  "Browsing the challenges, the leaderboard, the rules, and these policy pages requires no account and no sign-in. Nothing personal is collected while you read.",
                  "Sign in only if you want to claim your row on the leaderboard, see your own per-challenge breakdown, join a team, or reveal a hint. Working through the challenges without ever signing in is a perfectly valid way to use this event.",
                ]
              : [
                  "Browsing this site — the leaderboard, the rules, these policy pages — requires no account and no sign-in. Nothing personal is collected while you read.",
                  "Sign in only if you want to claim your row on the leaderboard, see your own progress, or join a team. Reading your way through without ever signing in is a perfectly valid way to use this event.",
                ]
          }
        />
      </Card>

      <Card heading="Signing in with GitHub">
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          We use GitHub OAuth and ask for the two narrowest scopes available:{" "}
          <span className="font-mono text-xs text-zinc-200">read:user</span> and{" "}
          <span className="font-mono text-xs text-zinc-200">user:email</span>. Both are
          read-only.
        </p>
        <Bullets
          items={[
            <>
              GitHub hands us your <span className="text-white">login</span>, numeric account
              id, display name, avatar URL, and email address.
            </>,
            <>
              Of those we keep exactly one: your{" "}
              <span className="text-white">GitHub login</span>,{" "}
              {secureDev
                ? "because the scorer credits points to the account that authored a pull request."
                : "because your points are recorded against the account you signed in with."}{" "}
              The rest renders the page you&apos;re on and is then forgotten.
            </>,
            <>
              We deliberately{" "}
              <span className="text-white">do not store the access token</span>{" "}
              GitHub issues at sign-in. This app never calls the GitHub API, so keeping that
              token would mean holding a credential we have no use for.
            </>,
            "There is no account database. Your session lives entirely in an encrypted cookie, so once it expires the sign-in has left nothing behind on our side.",
          ]}
        />
      </Card>

      <Card heading="What we store while you compete">
        {/* One bullet per store that this event actually writes to. Hints are
            secure-development's (hint-store.ts), answers are the quiz's
            (quiz-store.ts), solves/attempts are classic's (classic-store.ts)
            — listing any of these on an event that doesn't run it would be a
            promise about code that never executes, and omitting one that IS
            running would be a real gap: those records ARE stored. */}
        <Bullets
          items={[
            <>
              <span className="text-white">Team membership</span>: the team&apos;s name, who
              created it, and the GitHub logins of its members.
            </>,
            <>
              <span className="text-white">An activity log for the organizers</span>: when you
              signed in, when you solved something (recorded by its id, never the answer you
              submitted), and team changes, keyed to your GitHub login. Only organizers can see
              it, only the most recent few thousand entries are kept — older ones are
              discarded automatically — and it holds no IP address or device data.
            </>,
            ...(secureDev
              ? [
                  <>
                    <span className="text-white">Hint purchases</span>: which hints you revealed,
                    when, and the running point penalty against your login.
                  </>,
                  <>
                    <span className="text-white">Your scores</span>{" "}
                    come from the scoring pipeline, keyed to the GitHub login that authored the pull
                    request. This site reads them; it doesn&apos;t create them.
                  </>,
                ]
              : []),
            ...(quiz
              ? [
                  <>
                    <span className="text-white">Your answers</span>: which questions you have
                    answered, the choices you submitted, when, how many attempts you have spent,
                    and the points each answer earned, all keyed to your GitHub login.
                  </>,
                ]
              : []),
            ...(classic
              ? [
                  <>
                    <span className="text-white">Your classic progress</span>: which challenges
                    you have solved, the points you earned and when, how many attempts you have
                    made on each challenge and when, and your running point and solve totals, all
                    keyed to your GitHub login.
                  </>,
                ]
              : []),
          ]}
        />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          All of it is keyed to a public GitHub username and nothing more: no email, no real
          name, no device or location data. It lives in an Upstash Redis instance run for this
          event. Being straight with you: apart from the activity log&apos;s rolling cap, this
          competition data has no automatic expiry today, so treat it as kept until the
          organizers clear it down after the event. You can ask for yours sooner. See below.
        </p>
      </Card>

      <Card heading="Counting where the event reached">
        <p className="text-sm leading-relaxed text-zinc-400">
          We&apos;d like to be able to say which countries the CTF reached. So once per browser
          session, one number goes up: a tally against a{" "}
          <span className="text-white">country code</span>, and nothing else. No login, no IP
          address (not even a hashed or obfuscated one), no timestamp, no session id, nothing
          that could be traced back to a person or joined against anything else we hold.
        </p>
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          The country is worked out by our host from the connection and handed to us already
          reduced to a two-letter code; we never see or record the address behind it. What we
          end up with is a list that reads{" "}
          <span className="font-mono text-xs text-zinc-200">US 412 · DE 88 · JP 40</span>, a
          rough measure of reach rather than a headcount, and not personal data.
        </p>
      </Card>

      <Card heading="Cookies">
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          Four, all strictly functional, all marked{" "}
          <span className="font-mono text-xs text-zinc-200">httpOnly</span> so no script on the
          page can read them. None of them track you, and none follow you off this site.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="pb-2 pr-4 font-semibold text-white">Cookie</th>
                <th className="pb-2 pr-4 font-semibold text-white">What it&apos;s for</th>
                <th className="pb-2 font-semibold text-white">Lifetime</th>
              </tr>
            </thead>
            <tbody>
              {cookies.map((c) => (
                <tr key={c.name} className="border-b border-white/[0.06] last:border-0">
                  <td className="py-3 pr-4 align-top font-mono text-xs text-zinc-200">
                    {c.name}
                  </td>
                  <td className="py-3 pr-4 align-top leading-relaxed text-zinc-400">{c.what}</td>
                  <td className="py-3 align-top whitespace-nowrap text-muted">{c.life}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card heading="What other people can see">
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          The leaderboard is public (that&apos;s rather the point of a leaderboard), so
          it&apos;s worth being precise about where the line falls. Public:
        </p>
        <Bullets
          items={[
            secureDev
              ? "Your GitHub login and avatar, your rank, your points, and how many challenges you have patched and not patched."
              : "Your GitHub login and avatar, your rank, and your points.",
            "Your team, if you're on one. Expanding a team shows every member's login and avatar.",
            // Both of these describe secure-development's own board: the hint
            // penalty chip and the PR/commit columns the scorer supplies.
            ...(secureDev
              ? [
                  "The total point penalty from hints you've revealed. Which specific hints you bought stays private.",
                  "For some scoring modes, the number of your most recent pull request and a short commit hash.",
                ]
              : []),
          ]}
        />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          Not public, and not visible to other contestants or to organizers browsing the site:
          {secureDev
            ? " your email address, your real name, and the contents of any hint you've revealed."
            : quiz
              ? " your email address, your real name, and which questions you have answered."
              : classic
                ? " your email address, your real name, and which classic challenges you have solved or attempted."
                : " your email address and your real name."}
          {" "}Those appear only on your own profile page, behind your own session.
        </p>
      </Card>

      <Card heading="Who else is involved">
        <Bullets
          items={[
            <>
              <span className="text-white">GitHub</span>:{" "}
              {secureDev
                ? "handles sign-in, hosts the challenge repositories, and serves avatar images."
                : "handles sign-in and serves avatar images."}{" "}
              Worth knowing: avatars load straight from GitHub, so GitHub sees the IP of anyone
              viewing a page with avatars on it, including the leaderboard.
            </>,
            <>
              <span className="text-white">The event organizer</span>: hosts this site on their
              own infrastructure, so they process requests and keep standard server logs.
            </>,
            <>
              <span className="text-white">Upstash</span>: stores the competition data described
              above, in a Redis instance run for this event.
            </>,
            ...(event.discordUrl
              ? [
                  <>
                    <span className="text-white">Discord</span>: only ever a link from this
                    site. If you join, Discord&apos;s own privacy policy governs what happens
                    there.
                  </>,
                ]
              : []),
          ]}
        />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          Nothing is sold, nothing is used for advertising, and nothing is shared beyond the
          services above that make the event run. Our stores are backed up as a matter of
          routine, so a deleted record can persist in a backup for a short period before ageing
          out.
        </p>
      </Card>

      <Card heading="Your choices, and how to reach a human">
        <Bullets
          items={[
            secureDev
              ? "Don't sign in. Everything except your own profile, teams, and hints works signed out."
              : "Don't sign in. Everything except your own profile and teams works signed out — nothing you do while signed out is scored, and nothing about you is recorded.",
            "Leave your team at any time from your profile. That removes your login from the team record immediately.",
            "Clear your cookies, or just wait for them to expire, to end the session.",
          ]}
        />
        <p className="mt-4 text-sm leading-relaxed text-zinc-400">
          There is no self-serve delete button for competition data, so those requests go to a
          person. For access, correction, or deletion, contact OWASP at{" "}
          <a href={`mailto:${event.privacyContactEmail}`} className="ds-link font-mono">
            {event.privacyContactEmail}
          </a>
          , the address published in the{" "}
          <ExternalLink href={event.owaspPrivacyUrl}>OWASP Privacy Policy</ExternalLink>,
          which also sets out the rights available to you, including the additional rights of
          EEA and California residents.
          {(event.contactEmail || event.discordUrl) && (
            <>
              {" "}For CTF-specific data such as team membership
              {secureDev
                ? " or hint purchases"
                : quiz
                  ? " or your answers"
                  : classic
                    ? " or your classic solves"
                    : ""},{" "}
              {event.contactEmail && (
                <>
                  email the organizers at{" "}
                  <a href={`mailto:${event.contactEmail}`} className="ds-link font-mono">
                    {event.contactEmail}
                  </a>
                  {event.discordUrl ? ", or " : "."}
                </>
              )}
              {event.discordUrl && (
                <>
                  ask an organizer in the{" "}
                  <ExternalLink href={event.discordUrl}>CTF Discord</ExternalLink> if you want it
                  dealt with faster. You never have to join Discord to exercise a right over your
                  own data.
                </>
              )}
            </>
          )}{" "}
          One honest caveat: removing your scores from the leaderboard means withdrawing from
          the competition.
        </p>
      </Card>

      <p className="text-sm leading-relaxed text-muted">
        See also the{" "}
        <Link href="/terms" className="ds-link">
          terms
        </Link>{" "}
        and the{" "}
        <Link href="/code-of-conduct" className="ds-link">
          code of conduct
        </Link>
        .
      </p>
    </div>
  );
}
