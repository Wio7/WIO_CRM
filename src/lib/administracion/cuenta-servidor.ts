import { createClient } from "@/lib/supabase/server";
import { nombreApp } from "@/lib/apps/nombres";

/**
 * Nombre de la app de Administración para quien la abre (servidor): "Golden
 * Administración" en la cuenta Golden y "Administración" en las demás o sin
 * sesión. Nunca el nombre interno del producto.
 */
export async function nombreAppAdministracion(): Promise<string> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return nombreApp("administracion");
    const { data: perfil } = await supabase.from("profiles").select("account_id").eq("user_id", user.id).maybeSingle();
    if (!perfil?.account_id) return nombreApp("administracion");
    const { data: cuenta } = await supabase.from("accounts").select("name").eq("id", perfil.account_id).maybeSingle();
    // La marca es opcional (columna posterior): su error no cambia el nombre.
    const { data: marca } = await supabase.from("accounts").select("brand_name").eq("id", perfil.account_id).maybeSingle();
    return nombreApp("administracion", cuenta?.name, marca?.brand_name);
  } catch {
    return nombreApp("administracion");
  }
}
