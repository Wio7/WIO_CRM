import { NextResponse } from "next/server";
import { requireSuperAdmin, toErrorResponse } from "@/lib/auth/account";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  try {
    const { userId, platformAdmin } = await requireSuperAdmin();

    // 3. Parse request payload
    const { accountId } = await req.json();
    if (!accountId) {
      return NextResponse.json({ error: "Falta el identificador de la cuenta (accountId)" }, { status: 400 });
    }
    if (accountId === platformAdmin.home_account_id || accountId === platformAdmin.visiting_account_id) {
      return NextResponse.json({ error: "No puedes eliminar tu cuenta de origen ni la que estás visitando. Sal primero de la cuenta visitada." }, { status: 409 });
    }

    // 4. Create admin client
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    // 5. Fetch profiles of this account to delete their auth users
    const { data: profiles, error: fetchError } = await supabaseAdmin
      .from("profiles")
      .select("user_id")
      .eq("account_id", accountId);

    if (fetchError) {
      return NextResponse.json({ error: "Error al recuperar perfiles de la cuenta", details: fetchError.message }, { status: 500 });
    }

    // Comprobar antes de borrar a cualquier integrante, por si cambió la visita.
    if (profiles?.some(profile => profile.user_id === userId)) {
      return NextResponse.json({ error: "Sal de la cuenta antes de eliminarla" }, { status: 409 });
    }
    // 6. Delete each associated user from Supabase Auth
    for (const profile of profiles || []) {
      const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(profile.user_id);
      if (authDeleteError) {
        console.warn(`[API admin/accounts/delete] Failed to delete auth user ${profile.user_id}:`, authDeleteError.message);
      }
    }

    // 7. Delete the account (ON DELETE CASCADE in Postgres will delete profiles and remaining tables)
    const { error: accountDeleteError } = await supabaseAdmin
      .from("accounts")
      .delete()
      .eq("id", accountId);

    if (accountDeleteError) {
      return NextResponse.json({ error: "Error al eliminar la cuenta de la base de datos", details: accountDeleteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: "Cuenta y todos sus usuarios asociados eliminados correctamente" });
  } catch (error: unknown) {
    console.error("[API admin/accounts/delete] Exception:", error);
    return toErrorResponse(error);
  }
}
