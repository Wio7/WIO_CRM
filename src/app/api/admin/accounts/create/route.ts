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
    const { accountName, ownerName, email, password } = await req.json();
    if (!accountName || !ownerName || !email || !password) {
      return NextResponse.json({ error: "Todos los campos son obligatorios (Nombre de cuenta, propietario, email y contraseña)" }, { status: 400 });
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

    // 5. Check if user already exists
    const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) {
      return NextResponse.json({ error: "Error al verificar usuarios existentes", details: listError.message }, { status: 500 });
    }

    const existingUser = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (existingUser) {
      return NextResponse.json({ error: "El correo electrónico ya está registrado en el sistema" }, { status: 409 });
    }

    // 6. Create the user in Auth (this triggers public.handle_new_user automatically)
    const { data: authData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: ownerName,
        name: ownerName
      }
    });

    if (createError) {
      return NextResponse.json({ error: "Error al crear el usuario en Auth", details: createError.message }, { status: 500 });
    }

    const createdUser = authData.user;

    // 7. Retrieve the generated account_id from profiles table
    // The database trigger should have inserted this row. We retry a few times if there is a tiny delay.
    let profile = null;
    for (let i = 0; i < 5; i++) {
      const { data, error } = await supabaseAdmin
        .from("profiles")
        .select("account_id")
        .eq("user_id", createdUser.id)
        .single();
      
      if (data && data.account_id) {
        profile = data;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    if (!profile) {
      return NextResponse.json({ error: "El usuario fue creado pero no se pudo generar su perfil. Inténtalo de nuevo." }, { status: 500 });
    }

    // 8. Update the generated account's name to the requested accountName
    const { error: updateError } = await supabaseAdmin
      .from("accounts")
      .update({ name: accountName })
      .eq("id", profile.account_id);

    if (updateError) {
      console.warn(`[API admin/accounts/create] Failed to update account name to ${accountName}:`, updateError.message);
    }

    return NextResponse.json({ 
      success: true, 
      message: "Cuenta y propietario creados exitosamente", 
      account: {
        id: profile.account_id,
        name: accountName,
        ownerEmail: email
      }
    });
  } catch (error: any) {
    console.error("[API admin/accounts/create] Exception:", error);
    return NextResponse.json({ error: "Error interno del servidor", details: error.message }, { status: 500 });
  }
}
