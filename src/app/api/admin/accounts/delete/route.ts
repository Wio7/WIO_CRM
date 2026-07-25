import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  try {
    // 1. Authenticate user
    const client = await createServerClient();
    const { data: { user }, error: authError } = await client.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    // 2. Verify Super Admin email
    const superAdminEmail = (process.env.NEXT_PUBLIC_SUPER_ADMIN_EMAIL || "admin@wiocrm.com").toLowerCase();
    if (user.email?.toLowerCase() !== superAdminEmail) {
      return NextResponse.json({ error: "No autorizado: Requiere privilegios de Super Administrador" }, { status: 403 });
    }

    // 3. Parse request payload
    const { accountId } = await req.json();
    if (!accountId) {
      return NextResponse.json({ error: "Falta el identificador de la cuenta (accountId)" }, { status: 400 });
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
      .select("id")
      .eq("account_id", accountId);

    if (fetchError) {
      return NextResponse.json({ error: "Error al recuperar perfiles de la cuenta", details: fetchError.message }, { status: 500 });
    }

    // 6. Delete each associated user from Supabase Auth
    for (const profile of profiles || []) {
      const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(profile.id);
      if (authDeleteError) {
        console.warn(`[API admin/accounts/delete] Failed to delete auth user ${profile.id}:`, authDeleteError.message);
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
  } catch (error: any) {
    console.error("[API admin/accounts/delete] Exception:", error);
    return NextResponse.json({ error: "Error interno del servidor", details: error.message }, { status: 500 });
  }
}
