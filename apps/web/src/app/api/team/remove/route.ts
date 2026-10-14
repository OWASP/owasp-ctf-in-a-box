import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { removeMember } from "@/lib/team-store";

function statusForError(error: string): number {
  if (error.toLowerCase().includes("captain")) return 403;
  if (error.toLowerCase().includes("demo mode")) return 409;
  return 400;
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const login = (session.user as { login?: string }).login;
  if (!login) return NextResponse.json({ error: "session has no GitHub login" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const slug = typeof body.slug === "string" ? body.slug : "";
  const member = typeof body.member === "string" ? body.member : "";

  // `confirm: true` is the captain accepting the after-close warning;
  // only a literal true counts.
  const result = await removeMember(login, slug, member, { confirmClosed: body.confirm === true });
  if (!result.ok && result.needsConfirm) {
    return NextResponse.json({ error: result.error, needsConfirm: true }, { status: 409 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusForError(result.error) });
  return NextResponse.json({ team: result.team });
}
