import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { errorLabel } from "@/lib/error-label";
import { AdminValidationError, updateAdminSettings, type SettingsPatch } from "@/lib/admin-store";

export async function POST(request: Request) {
  const gate = await requireAdmin(request.headers);
  if (!gate.ok) return NextResponse.json({ error: "forbidden" }, { status: gate.status });
  const patch = (await request.json().catch(() => ({}))) as SettingsPatch;
  try {
    const settings = await updateAdminSettings(patch, gate.login);
    return NextResponse.json({ settings });
  } catch (err) {
    if (err instanceof AdminValidationError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: 400 });
    }
    console.error("[admin/settings] write failed", errorLabel(err));
    return NextResponse.json({ error: "settings write failed" }, { status: 503 });
  }
}
