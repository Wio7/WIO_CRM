// ============================================================
// Avisos de etapa de un lote (Golden App): "Lote en proceso",
// "Lote separado" y "Lote vendido".
//
// Los cambios de etapa ocurren en la base del catálogo (otra base);
// aquí sólo se arma el aviso y se confirma, del lado del servidor, que
// el lote de verdad está en la etapa que se avisa. El texto lo arma este
// módulo, no el cliente: el aviso lleva proyecto, lote y asesor, nunca
// datos del cliente comprador.
// ============================================================

export const EVENTOS_SEPARACION = ["solicitada", "aprobada", "vendida"] as const;
export type EventoSeparacion = (typeof EVENTOS_SEPARACION)[number];
/** Compatibilidad: un cliente anterior no manda el evento y se entiende "aprobada". */
export const EVENTO_POR_DEFECTO: EventoSeparacion = "aprobada";

export const esEvento = (valor: unknown): valor is EventoSeparacion =>
  typeof valor === "string" && (EVENTOS_SEPARACION as readonly string[]).includes(valor);

const TITULOS: Record<EventoSeparacion, string> = {
  solicitada: "Lote en proceso",
  aprobada: "Lote separado",
  vendida: "Lote vendido",
};

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

/**
 * "Lote en proceso" | "Lote separado" | "Lote vendido" y, debajo,
 * "Colinas 2 · H-26 (Carlos Merino)". Al tocarlo abre el plano del proyecto.
 */
export function armarAvisoSeparacion(datos: {
  evento?: EventoSeparacion;
  proyecto: string;
  nombreProyecto?: string;
  lote: string;
  asesor?: string;
}): AvisoSeparacion {
  const nombre = limpio(datos.nombreProyecto, 40) || datos.proyecto;
  const asesor = limpio(datos.asesor, 60);
  const lote = limpio(datos.lote, 12);
  const evento = datos.evento ?? EVENTO_POR_DEFECTO;
  return {
    title: TITULOS[evento],
    body: `${nombre} · ${lote}${asesor ? ` (${asesor})` : ""}`.slice(0, 140),
    url: `/#/lotes/${datos.proyecto}`,
    // La aprobación conserva su etiqueta de siempre; los otros dos no la pisan.
    tag: `separacion-${datos.proyecto}-${lote}${evento === EVENTO_POR_DEFECTO ? "" : `-${evento}`}`,
  };
}

export interface SolicitudAprobada {
  proyecto: string;
  lote: string;
  asesor: string;
  /** Cuándo se aprobó (null si aún está pendiente). */
  resuelta: string | null;
  /** Cuándo se pidió. */
  creada?: string | null;
  /** Última vez que cambió el lote (para la venta). */
  actualizado?: string | null;
  estado_lote?: string;
  evento?: string;
}

export type ResultadoConsulta =
  | { estado: "aprobada"; solicitud: SolicitudAprobada }
  | { estado: "no_aprobada" }
  | { estado: "sin_config" }
  | { estado: "error" };

/** Instante que acredita la etapa recién ocurrida: de ahí se mide la vigencia del aviso. */
export function instanteDelEvento(s: SolicitudAprobada, evento: EventoSeparacion): string | null {
  const t = evento === "solicitada" ? s.creada : evento === "vendida" ? s.actualizado : s.resuelta;
  return t ?? null;
}

/**
 * Pregunta a la base del catálogo (función `gh_aviso_separacion`, migración
 * 0010 de la Golden App) si la solicitud y su lote están de verdad en la
 * etapa del evento. Usa la clave pública que el CRM ya tiene para leer el
 * catálogo; la función no devuelve datos del cliente. Ante cualquier duda
 * responde "error": jamás se avisa por las dudas. `estado: "aprobada"`
 * significa "la etapa se confirmó" (nombre heredado del primer evento).
 */
export async function consultarAvisoSeparacion(
  solicitudId: string,
  evento: EventoSeparacion = EVENTO_POR_DEFECTO,
): Promise<ResultadoConsulta> {
  const url = process.env.GOLDEN_SUPABASE_URL?.trim();
  const key = process.env.GOLDEN_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return { estado: "sin_config" };
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/gh_aviso_separacion`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_solicitud: solicitudId, p_evento: evento }),
      cache: "no-store",
    });
    if (!res.ok) return { estado: "error" };
    const filas = (await res.json()) as SolicitudAprobada[];
    return filas?.[0] ? { estado: "aprobada", solicitud: filas[0] } : { estado: "no_aprobada" };
  } catch {
    return { estado: "error" };
  }
}

/** Versión de siempre: ¿está aprobada? */
export const consultarSeparacionAprobada = (solicitudId: string) =>
  consultarAvisoSeparacion(solicitudId, "aprobada");
