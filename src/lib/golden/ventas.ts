// ============================================================
// Las ventas de lotes de cada asesor, para el ranking del agente.
//
// Una venta es una separación aprobada cuyo lote sigue separado o vendido.
// Viven en el Supabase de la app (gh_lotes_solicitudes), que sólo el
// administrador puede leer: por eso esto usa su clave de servicio, sólo aquí
// en el servidor, y nunca pide las columnas con datos del cliente.
//
// El asesor es texto escrito a mano en el formulario de separación. Ante la
// duda no se adivina: lo que no se pueda atribuir a una sola persona se
// informa con el nombre tal cual, para que la venta no se pierda.
// ============================================================

export interface FilaSeparacion {
  proyecto: string;
  lote: string;
  asesor: string;
  moneda: string;
  monto: number;
  precio_lote: number | null;
  resuelta: string | null;
}

export type LecturaDeSeparaciones =
  | { estado: "sin_clave" }
  | { estado: "error" }
  | { estado: "ok"; filas: FilaSeparacion[]; estados: Map<string, string> };

const PAGINA = 1000;
const VIGENTES = new Set(["separado", "vendido"]);
const clave = (proyecto: string, lote: string) => `${proyecto}|${lote}`;

/**
 * Las ventas de un periodo. Un lote cuenta una sola vez, por su última
 * aprobación, y sólo si sigue tomado: si se liberó, ya no es una venta.
 */
export function ventasDeSeparaciones(
  filas: FilaSeparacion[],
  estados: Map<string, string>,
  rango: { desde: string; hasta: string },
): FilaSeparacion[] {
  const ultima = new Map<string, FilaSeparacion>();
  for (const f of filas) {
    if (!f.resuelta) continue;
    const k = clave(f.proyecto, f.lote);
    const previa = ultima.get(k);
    if (!previa || Date.parse(f.resuelta) > Date.parse(previa.resuelta!)) ultima.set(k, f);
  }
  const desde = Date.parse(rango.desde);
  const hasta = Date.parse(rango.hasta);
  return [...ultima.values()].filter((f) => {
    const t = Date.parse(f.resuelta!);
    return t >= desde && t < hasta && VIGENTES.has(estados.get(clave(f.proyecto, f.lote)) ?? "");
  });
}

const palabras = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** A quién del equipo se refiere un nombre escrito a mano, si es a uno solo. */
export function emparejarAsesor(
  texto: string,
  equipo: { user_id: string; full_name?: string | null; email?: string | null }[],
): string | null {
  const dicho = palabras(texto);
  const junto = dicho.join("");
  if (junto.length < 2) return null;

  const fichas = equipo.map((m) => ({
    id: m.user_id,
    nombre: palabras(m.full_name),
    correo: palabras((m.email ?? "").split("@")[0]),
  }));
  const unico = (lista: { id: string }[]) => (lista.length === 1 ? lista[0].id : null);

  const exactos = fichas.filter((f) => f.nombre.join("") === junto || f.correo.join("") === junto);
  if (exactos.length) return unico(exactos);

  const contenido = (parte: string[], todo: string[]) => parte.length > 0 && parte.every((p) => todo.includes(p));
  return unico(
    fichas.filter(
      (f) => contenido(dicho, f.nombre) || contenido(f.nombre, dicho) || contenido(dicho, f.correo),
    ),
  );
}

/** PostgREST entrega como mucho mil filas por consulta, por más que se pida. */
async function todasLasFilas<T>(url: string, ruta: string, key: string): Promise<T[]> {
  const filas: T[] = [];
  for (let offset = 0; ; offset += PAGINA) {
    const res = await fetch(`${url}/rest/v1/${ruta}&limit=${PAGINA}&offset=${offset}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${ruta} respondió ${res.status}`);
    const pagina = (await res.json()) as T[];
    filas.push(...pagina);
    if (pagina.length < PAGINA) return filas;
  }
}

/** Las separaciones aprobadas y el estado de los lotes tomados. */
export async function leerSeparaciones(): Promise<LecturaDeSeparaciones> {
  const url = process.env.GOLDEN_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.GOLDEN_SUPABASE_SERVICE_KEY?.trim();
  if (!url || !key) return { estado: "sin_clave" };
  try {
    const [filas, lotes] = await Promise.all([
      todasLasFilas<FilaSeparacion>(
        url,
        "gh_lotes_solicitudes?select=proyecto,lote,asesor,moneda,monto,precio_lote,resuelta&estado=eq.aprobada&order=id",
        key,
      ),
      todasLasFilas<{ proyecto: string; lote: string; estado: string }>(
        url,
        "gh_lotes_estado?select=proyecto,lote,estado&estado=in.(separado,vendido)&order=proyecto,lote",
        key,
      ),
    ]);
    return { estado: "ok", filas, estados: new Map(lotes.map((l) => [clave(l.proyecto, l.lote), l.estado])) };
  } catch (err) {
    console.error("[golden ventas] no se pudieron leer las separaciones:", err);
    return { estado: "error" };
  }
}
