// /faq is a PLATFORM frame with module contributions, on the same basis as
// /rules and /how-to-play. The platform owns the page furniture and the three
// questions that hold on any event whatsoever — can I compete solo, is there a
// prize, where do I find an organizer — and each enabled module contributes
// the questions that name its own artifacts.
//
// This page was 100% secure-development, and it is in the HEADER NAV: a
// quiz-only event linked contestants straight from its own navigation to a
// page telling them to fork a target, open a pull request, and wait for the
// scorer. Not an obscure corner.
//
// Server Component, and must stay one: `ModuleFaq` is a FUNCTION of the live
// event facts, called here so only plain data reaches the client accordion.
// See lib/modules.ts for why it never rides on a ResolvedModule.
import type { Metadata } from "next";
import PageHeader from "@/components/page-header";
import ModuleCopy from "@/components/module-copy";
import FaqAccordion, { type QA } from "@/components/faq-accordion";
import { joinAppNames } from "@/lib/apps";
import { getEnabledApps } from "@/lib/enabled-apps";
import type { FaqContext, ModuleFaq } from "@/lib/modules";
import { getModuleFaq, getResolvedModules } from "@/lib/resolved-modules";
import { getHintNotice } from "@/lib/hint-store";
import { getSite } from "@/lib/site";
import { getGithubOrg } from "@/lib/bootstrap-env";

export async function generateMetadata(): Promise<Metadata> {
  const event = await getSite();
  return {
    title: "FAQ",
    // Module-agnostic: this page's questions come from whichever modules the
    // event enables, so the description cannot name one of them (it used to
    // say "secure development CTF" on every event, including one with no such
    // module).
    description: `Frequently asked questions about ${event.name}.`,
  };
}

/** One module's question, as the registry writes it. Derived from `ModuleFaq`
 *  rather than restated, so a change to the block's shape fails here. */
type FaqItem = NonNullable<ReturnType<ModuleFaq>["gettingStarted"]>[number];

export default async function FaqPage() {
  const event = await getSite();
  const enabledApps = await getEnabledApps();
  // The hint price is an /admin runtime setting, so the answer that quotes it
  // has to read the live value rather than restate the default (issue #315) —
  // the same value /challenges and the reveal button already render.
  const ctx: FaqContext = {
    appCount: enabledApps.length,
    appList: joinAppNames(enabledApps.map((a) => a.name)),
    // "" is a misconfiguration the setup wizard refuses and `doctor` flags; prose that interpolates the org is not guarded here (#386).
    githubOrg: getGithubOrg(),
    hintCost: (await getHintNotice()).cost,
  };

  // Registry order, plain data: the `faq` blocks are invoked HERE, on the
  // server, and only the resulting `Copy` travels into <ModuleCopy>.
  //
  // The module TITLE is carried alongside each contribution because several
  // modules legitimately answer the same question — see the merge below.
  const contributions = (await getResolvedModules()).flatMap((module) => {
    const faq = getModuleFaq(module.id);
    return faq ? [{ title: module.title, copy: faq(ctx) }] : [];
  });

  // Modules ask the reader's questions, not the platform's, so the generic
  // ones collide by design: every module has a "do I need experience" and a
  // "what do I need to bring", each answered in its own terms. Concatenating
  // them rendered the SAME question text three times on an all-modules event
  // — three identical collapsed rows, which reads as a bug rather than as
  // three answers. (It shipped because the only FAQ tests were quiz-only and
  // classic-only, and a single-module event cannot collide.)
  //
  // So: group by question text, keep first-seen order, and merge a collision
  // into one entry whose answer is labelled per module. Nothing is dropped
  // and no module has to reword a question to avoid its neighbours. A
  // single-module event takes the `length === 1` path and renders exactly as
  // it did before.
  const fromModules = (section: "gettingStarted" | "prep" | "playing"): QA[] => {
    const order: string[] = [];
    const byQuestion = new Map<string, { title: string; item: FaqItem }[]>();
    for (const { title, copy } of contributions) {
      for (const item of copy[section] ?? []) {
        const group = byQuestion.get(item.q);
        if (group) group.push({ title, item });
        else {
          byQuestion.set(item.q, [{ title, item }]);
          order.push(item.q);
        }
      }
    }
    return order.map((q) => {
      const group = byQuestion.get(q) ?? [];
      if (group.length === 1) {
        const [{ item }] = group;
        return { q, id: item.id, a: <ModuleCopy copy={item.a} /> };
      }
      return {
        q,
        // First id wins: the anchor keeps pointing at the same panel, which is
        // now the merged one rather than the first of several look-alikes.
        id: group.find(({ item }) => item.id)?.item.id,
        a: (
          <div className="flex flex-col gap-4">
            {group.map(({ title, item }) => (
              <div key={title} className="flex flex-col gap-1">
                <p className="text-[11px] uppercase tracking-wide text-muted">{title}</p>
                <ModuleCopy copy={item.a} />
              </div>
            ))}
          </div>
        ),
      };
    });
  };

  // The platform's own questions are interleaved, not bolted on either end:
  // "Can I compete solo?" belongs between a module's "do I need experience"
  // and its "what do I need to bring", and the page reads wrong if every
  // module question is shunted to one end. That is what the buckets are for.
  const faqs: QA[] = [
    ...fromModules("gettingStarted"),
    {
      q: "Can I compete solo?",
      a: "Yes — hit Play solo on your profile for a one-click team of one. Scoring requires a team, so solo play is simply a team of one; you can also create or join a team of up to four.",
    },
    ...fromModules("prep"),
    ...fromModules("playing"),
    {
      // The same order rank.ts `compareStanding` applies (#522).
      q: "How is the leaderboard ranked?",
      a: "By points. At equal points, whoever completed more items ranks higher, and after that whoever got there first. Teams are ranked by points.",
    },
    {
      q: "Is there a prize?",
      a: "Yes. Prizes go to the top individuals and top teams overall. You must be present at the closing ceremony to claim.",
    },
    {
      q: "Where do I ask for help during the event?",
      a: (
        <>
          Find an organizer at the {event.name} area
          {event.discordUrl && (
            <>
              , or join the{" "}
              <a
                href={event.discordUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ds-link"
              >
                CTF Discord
              </a>
              , where scoring questions, stuck runs, and organizer announcements go
            </>
          )}
          .
        </>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Questions"
        title="FAQ"
        description={
          <>
            Quick answers to the things contestants ask most. Still stuck? Find an organizer at
            the {event.name} area
            {event.discordUrl && (
              <>
                , or ask in the{" "}
                <a
                  href={event.discordUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ds-link"
                >
                  CTF Discord
                </a>
              </>
            )}
            .
          </>
        }
      />
      <FaqAccordion items={faqs} />
    </div>
  );
}
