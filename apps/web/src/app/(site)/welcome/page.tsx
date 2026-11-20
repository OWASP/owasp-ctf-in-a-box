// A first OAuth sign-in lands here from /api/post-signin to pick a username.
// Reached with no session it goes home; with a username already set there is
// nothing to ask, so it passes on to the sanitized `next`.
//
// Dynamic (reads the session), like its siblings.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import PageHeader from "@/components/page-header";
import UsernamePickForm from "@/components/username-pick-form";
import { getPlayer } from "@/lib/player";
import { sanitizeNext } from "@/lib/post-signin";

export const metadata: Metadata = { title: "Pick a username" };

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const player = await getPlayer(await headers());
  if (!player) redirect("/");
  const raw = (await searchParams).next;
  const next = sanitizeNext(Array.isArray(raw) ? raw[0] : raw);
  if (player.username) redirect(next);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Welcome"
        title="Pick a username"
        description="This is the name other players see on the leaderboard and team pages."
      />
      <UsernamePickForm next={next} />
    </div>
  );
}
