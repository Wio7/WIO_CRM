import { createClient } from "@/lib/supabase/server";
import { nombreApp } from "@/lib/apps/nombres";

/**
 * Nombre de la app de Cobranzas para quien la abre (servidor): "Golden
 * Cobranzas" en la cuenta Golden y "Cobranzas" en las demás o sin sesión.
 * Nunca el nombre interno del producto.
 */
export async function nombreAppCobranzas(): Promise<string> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return nombreApp("cobranzas");
    const { data: perfil } = await supabase.from("profiles").select("account_id").eq("user_id", user.id).maybeSingle();
    if (!perfil?.account_id) return nombreApp("cobranzas");
    const { data: cuenta } = await supabase.from("accounts").select("name").eq("id", perfil.account_id).maybeSingle();
    // La marca es opcional (columna posterior): su error no cambia el nombre.
    const { data: marca } = await supabase.from("accounts").select("brand_name").eq("id", perfil.account_id).maybeSingle();
    return nombreApp("cobranzas", cuenta?.name, marca?.brand_name);
  } catch {
    return nombreApp("cobranzas");
  }
}
