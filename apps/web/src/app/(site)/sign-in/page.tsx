// Where every "sign in" control leads. A signed-in visitor is sent straight to
// where they were headed; everyone else gets the username + password form and
// the GitHub button. `next` is attacker-influenceable, so it is sanitized here
// and again by /api/post-signin.
//
// Dynamic (reads the session), like its siblings.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import PageHeader from "@/components/page-header";
import PasswordAuthForm from "@/components/password-auth-form";
import { getPlayer } from "@/lib/player";
import { sanitizeNext } from "@/lib/post-signin";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).next;
  const next = sanitizeNext(Array.isArray(raw) ? raw[0] : raw);
  if (await getPlayer(await headers())) redirect(next);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="Account" title="Sign in" description="Sign in, or create an account to play." />
      <PasswordAuthForm next={next} />
    </div>
  );
}
