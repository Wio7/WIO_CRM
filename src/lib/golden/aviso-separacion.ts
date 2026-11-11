// ============================================================
// Aviso "Lote separado" cuando se APRUEBA una separación (Golden App).
//
// La aprobación ocurre en la base del catálogo (otra base); aquí sólo
// se arma el aviso y se confirma, del lado del servidor, que esa
// solicitud de verdad está aprobada. El texto lo arma este módulo, no
// el cliente: el aviso lleva proyecto, lote y asesor, nunca datos del
// cliente comprador.
// ============================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Una aprobación más vieja que esto no dispara aviso (evita reenvíos tardíos). */
export const VIGENCIA_APROBACION_MS = 15 * 60_000;

export const esUuid = (valor: unknown): valor is string =>
  typeof valor === "string" && UUID.test(valor);

export function solicitudReciente(resuelta: string | null | undefined, ahora = Date.now()): boolean {
  const t = resuelta ? Date.parse(resuelta) : NaN;
  return Number.isFinite(t) && ahora - t >= 0 && ahora - t <= VIGENCIA_APROBACION_MS;
}

const limpio = (texto: unknown, max: number) =>
  String(texto ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export interface AvisoSeparacion {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** "Lote separado" / "Colinas 2 · H-26 (Carlos Merino)", y al tocarlo abre el plano del proyecto. */
export function armarAvisoSeparacion(datos: {
  proyecto: string;
  nombreProyecto?: string;
  lote: string;
  asesor?: string;
}): AvisoSeparacion {
  const nombre = limpio(datos.nombreProyecto, 40) || datos.proyecto;
  const asesor = limpio(datos.asesor, 60);
  const lote = limpio(datos.lote, 12);
  return {
    title: "Lote separado",
    body: `${nombre} · ${lote}${asesor ? ` (${asesor})` : ""}`.slice(0, 140),
    url: `/#/lotes/${datos.proyecto}`,
    tag: `separacion-${datos.proyecto}-${lote}`,
  };
}

export interface SolicitudAprobada {
  proyecto: string;
  lote: string;
  asesor: string;
  resuelta: string;
}

export type ResultadoConsulta =
  | { estado: "aprobada"; solicitud: SolicitudAprobada }
  | { estado: "no_aprobada" }
  | { estado: "sin_config" }
  | { estado: "error" };

/**
 * Pregunta a la base del catálogo (función `gh_aviso_separacion`, migración
 * 0008 de la Golden App) si la solicitud está aprobada. Usa la clave pública
 * que el CRM ya tiene para leer el catálogo; la función no devuelve datos del
 * cliente. Ante cualquier duda responde "error": jamás se avisa por las dudas.
 */
export async function consultarSeparacionAprobada(solicitudId: string): Promise<ResultadoConsulta> {
  const url = process.env.GOLDEN_SUPABASE_URL?.trim();
  const key = process.env.GOLDEN_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return { estado: "sin_config" };
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/gh_aviso_separacion`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_solicitud: solicitudId }),
      cache: "no-store",
    });
    if (!res.ok) return { estado: "error" };
    const filas = (await res.json()) as SolicitudAprobada[];
    return filas?.[0] ? { estado: "aprobada", solicitud: filas[0] } : { estado: "no_aprobada" };
  } catch {
    return { estado: "error" };
  }
}
