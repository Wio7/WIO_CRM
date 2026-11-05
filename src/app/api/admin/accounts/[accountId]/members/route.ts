import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSuperAdmin, toErrorResponse } from "@/lib/auth/account";

/**
 * GET /api/admin/accounts/[accountId]/members  (solo super admin)
 *
 * Personas que entran a una cuenta (perfiles con ese account_id), para
 * desplegarlas debajo del negocio en el panel Cuentas. Solo lectura.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await params;
    await requireSuperAdmin();

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email, account_role, area")
      .eq("account_id", accountId)
      .order("created_at", { ascending: true });

    if (error) {
      return NextResponse.json(
        { error: "No se pudo leer el equipo de la cuenta", details: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ members: data ?? [] });
  } catch (error: unknown) {
    console.error("[API admin/accounts/members] Exception:", error);
    return toErrorResponse(error);
  }
}
