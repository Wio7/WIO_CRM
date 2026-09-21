// ============================================================
// /api/whatsapp/templates/disponibles — las plantillas que se pueden mandar
//
//   GET → { ok, plantillas: [{ nombre, idioma, categoria, cuerpo,
//                              encabezado, pie, variables, ejemplo }] }
//
// Para la Golden App: cuando se cierra la ventana de 24 h de WhatsApp, el
// asesor sólo puede retomar con una plantilla aprobada por Meta. Hasta
// ahora la app le decía "hazlo desde el CRM", que es pedirle que se salga
// de la aplicación justo en el momento en el que está intentando no
// perder un cliente.
//
// Devuelve SÓLO las aprobadas. Una plantilla en revisión o rechazada no
// se puede enviar, y enseñarla sería ofrecer un botón que falla.
//
// Corre con la sesión de quien pregunta: desde la 017 las políticas de
// `message_templates` son por cuenta (`is_account_member`), así que la
// base ya enseña las de su equipo y sólo ésas.
// ============================================================

import { NextResponse } from "next/server";

import { getRequestAuth } from "@/lib/supabase/request-auth";
import { corsPreflight, withCors } from "@/lib/cors";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

/** Los {{1}}, {{2}}… de un texto, en orden y sin repetir. */
export function variablesDe(texto: string | null): number[] {
  if (!texto) return [];
  const vistas = new Set<number>();
  for (const m of texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const n = Number(m[1]);
    if (n > 0) vistas.add(n);
  }
  return [...vistas].sort((a, b) => a - b);
}

interface FilaPlantilla {
  name: string;
  language: string | null;
  category: string | null;
  status: string | null;
  header_type: string | null;
  header_content: string | null;
  body_text: string | null;
  footer_text: string | null;
  sample_values: { body?: string[]; header?: string[] } | null;
}

/** Meta usa mayúsculas desde la 014; 001 usaba 'Approved'. */
const aprobada = (estado: string | null) => (estado ?? "").toUpperCase() === "APPROVED";

export async function GET(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) {
    return withCors(request, NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }));
  }

  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id) {
    return withCors(request, NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 }));
  }

  const { data, error } = await supabase
    .from("message_templates")
    .select("name, language, category, status, header_type, header_content, body_text, footer_text, sample_values")
    .eq("account_id", perfil.account_id)
    .order("name");

  if (error) {
    console.error("[templates/disponibles] lookup failed:", error.message);
    return withCors(request, NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }));
  }

  const filas = (data ?? []) as unknown as FilaPlantilla[];
  const plantillas = filas.filter((f) => aprobada(f.status)).map((f) => ({
    nombre: f.name,
    idioma: f.language || "es",
    categoria: f.category,
    encabezado: f.header_type === "text" ? f.header_content : null,
    tipo_encabezado: f.header_type,
    cuerpo: f.body_text,
    pie: f.footer_text,
    variables: variablesDe(f.body_text),
    // Lo que se le mandó a Meta como ejemplo: sirve de marcador de
    // posición en el formulario, para que el asesor vea qué va en cada
    // hueco sin tener que adivinarlo.
    ejemplo: f.sample_values?.body ?? [],
  }));

  return withCors(
    request,
    NextResponse.json({
      ok: true,
      plantillas,
      // Para poder explicar en la app por qué la lista está vacía.
      total_sin_aprobar: filas.length - plantillas.length,
    }),
  );
}
