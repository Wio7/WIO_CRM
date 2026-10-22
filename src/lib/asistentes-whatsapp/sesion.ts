// ============================================================
// Un cliente de Supabase CON LA SESIÓN de la persona del equipo que
// escribió por WhatsApp.
//
// El webhook sólo tiene la clave de servicio, que se salta todos los
// permisos. Los asistentes de Golden App y Golden Legal están hechos para
// correr con el JWT de quien pregunta (RLS, legal_role…), así que aquí se
// le abre una sesión a esa persona: se genera un enlace mágico con la
// clave de servicio (no se envía ningún correo) y se canjea en el acto.
// El resultado ve exactamente lo que esa persona ve en la app.
//
// La sesión se guarda en memoria mientras dure (una hora, la duración del
// JWT) para no abrir una nueva en cada mensaje.
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/flows/admin-client";

const MARGEN_MS = 5 * 60 * 1000;
const sesiones = new Map<string, { db: SupabaseClient; vence: number }>();

const opciones = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export async function clienteDeLaPersona(userId: string): Promise<SupabaseClient> {
  const guardada = sesiones.get(userId);
  if (guardada && guardada.vence - MARGEN_MS > Date.now()) return guardada.db;

  const admin = supabaseAdmin();
  const { data: usuario, error: errUsuario } = await admin.auth.admin.getUserById(userId);
  const email = usuario?.user?.email;
  if (errUsuario || !email) throw new Error("No encontré la cuenta de esta persona.");

  const { data: enlace, error: errEnlace } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = enlace?.properties?.hashed_token;
  if (errEnlace || !tokenHash) throw new Error("No pude abrir la sesión de esta persona.");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const { data: canje, error: errCanje } = await createClient(url, anon, opciones).auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });
  const sesion = canje?.session;
  if (errCanje || !sesion) throw new Error("No pude abrir la sesión de esta persona.");

  const db = createClient(url, anon, {
    ...opciones,
    global: { headers: { Authorization: `Bearer ${sesion.access_token}` } },
  });
  sesiones.set(userId, { db, vence: (sesion.expires_at ?? 0) * 1000 });
  return db;
}
