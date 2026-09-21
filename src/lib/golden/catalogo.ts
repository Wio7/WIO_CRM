// ============================================================
// Lo que la IA sabe de lo que Golden vende.
//
// Sale de la propia Golden App, que es donde el equipo sube las casas,
// los lotes y los departamentos. Nada de listas pegadas a mano en el
// prompt: lo que el cliente ve en la app y lo que la IA le cuenta por
// WhatsApp son el mismo dato, y cuando cambia uno cambia el otro.
//
// Son dos fuentes, porque cambian a ritmos distintos:
//
//   · La FORMA del catálogo —qué proyectos hay, dónde están, qué lotes
//     tiene cada plano y de cuántos metros— se publica con la app en
//     `/catalogo-ia.json`. Cambia cuando se despliega, que es justo
//     cuando cambia también para el cliente.
//   · Lo que cambia TODOS LOS DÍAS —el precio que edita marketing y qué
//     lote sigue libre— se lee en vivo del Supabase de la app
//     (`gh_catalogo`, `gh_lotes_estado`), con su clave pública: es
//     información que ya es pública en la vitrina.
//
// Si la app no contesta, esto devuelve null y la IA sigue con lo que
// tenga escrito a mano en sus instrucciones. Quedarse sin catálogo no
// puede significar quedarse sin contestar.
// ============================================================

/** Cuánto se reutiliza lo leído. Un chat no necesita el dato al segundo. */
const VIGENCIA_MS = 10 * 60_000;

export interface LoteDelPlano {
  id: string;
  mz: string | null;
  area: number | null;
  estado: string;
}

export interface ProyectoDeGolden {
  id: string;
  nombre: string;
  nombreCorto: string | null;
  lema: string | null;
  categoria: string | null;
  estado: string;
  descripcion: string | null;
  donde: { direccion: string | null; distrito: string | null; ciudad: string | null };
  comercial: {
    precioDesde: number | null;
    precioHasta: number | null;
    moneda: string;
    inicialDesde: number | null;
    cuotaDesde: number | null;
    plazoMeses: number | null;
    financiamiento: string | null;
    rangoAreas: string | null;
    unidades: number | null;
    dormitorios: number | null;
  };
  puntosVenta: string[];
  lotes: LoteDelPlano[] | null;
  unidades:
    | { id: string; nombre: string; area: number; precio: number | null; terraza: boolean; disponible: boolean }[]
    | null;
}

export interface CatalogoDeGolden {
  generado: string;
  contacto: { whatsapp: string | null; correo: string | null; oficina: string | null };
  proyectos: ProyectoDeGolden[];
}

/** Una fila de `gh_catalogo`: lo que marketing edita desde el panel. */
interface FilaCatalogo {
  id: string;
  nombre: string | null;
  estado: string | null;
  precio_desde: number | null;
  precio_hasta: number | null;
  moneda: string | null;
  descripcion: string | null;
  financiamiento: string | null;
  area_rango: string | null;
  oculto: boolean | null;
}

/** Una fila de `gh_lotes_estado`: el estado vigente de un lote. */
interface FilaLote {
  proyecto: string;
  lote: string;
  estado: string;
  precio: number | null;
  moneda: string | null;
}

let cache: { cuando: number; datos: CatalogoDeGolden | null } | null = null;
let enVuelo: Promise<CatalogoDeGolden | null> | null = null;

const sinBarra = (u: string) => u.replace(/\/+$/, "");

async function pedirJson<T>(url: string, cabeceras: Record<string, string> = {}): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: cabeceras,
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[golden catálogo] ${url} respondió ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[golden catálogo] no se pudo leer ${url}:`, err);
    return null;
  }
}

/** Lo que edita marketing, por id de proyecto. */
async function catalogoPublicado(): Promise<Map<string, FilaCatalogo>> {
  const url = process.env.GOLDEN_SUPABASE_URL?.trim();
  const key = process.env.GOLDEN_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return new Map();
  const filas = await pedirJson<FilaCatalogo[]>(
    `${sinBarra(url)}/rest/v1/gh_catalogo?select=id,nombre,estado,precio_desde,precio_hasta,moneda,descripcion,financiamiento,area_rango,oculto`,
    { apikey: key, Authorization: `Bearer ${key}` },
  );
  return new Map((filas ?? []).map((f) => [f.id, f]));
}

/** El estado vigente de cada lote, por proyecto. */
async function estadosDeLotes(): Promise<Map<string, Map<string, FilaLote>>> {
  const url = process.env.GOLDEN_SUPABASE_URL?.trim();
  const key = process.env.GOLDEN_SUPABASE_ANON_KEY?.trim();
  const mapa = new Map<string, Map<string, FilaLote>>();
  if (!url || !key) return mapa;
  // PostgREST corta en 1000 filas por defecto y hay más de mil lotes: sin
  // el rango, los últimos proyectos se quedarían con el estado del plano.
  const filas = await pedirJson<FilaLote[]>(
    `${sinBarra(url)}/rest/v1/gh_lotes_estado?select=proyecto,lote,estado,precio,moneda`,
    { apikey: key, Authorization: `Bearer ${key}`, Range: "0-9999" },
  );
  for (const f of filas ?? []) {
    if (!mapa.has(f.proyecto)) mapa.set(f.proyecto, new Map());
    mapa.get(f.proyecto)!.set(f.lote, f);
  }
  return mapa;
}

/**
 * El catálogo de Golden, fusionado y listo para usar. `null` cuando no
 * se puede leer (sin `GOLDEN_APP_URL`, la app caída, la red cortada).
 */
export async function catalogoDeGolden(): Promise<CatalogoDeGolden | null> {
  if (cache && Date.now() - cache.cuando < VIGENCIA_MS) return cache.datos;
  if (enVuelo) return enVuelo;

  enVuelo = (async () => {
    const app = process.env.GOLDEN_APP_URL?.trim();
    if (!app) return null;

    const base = await pedirJson<CatalogoDeGolden>(`${sinBarra(app)}/catalogo-ia.json`);
    if (!base?.proyectos?.length) return null;

    const [publicado, lotesVivos] = await Promise.all([catalogoPublicado(), estadosDeLotes()]);

    const proyectos = base.proyectos
      .map((p) => {
        const vivo = publicado.get(p.id);
        const estados = lotesVivos.get(p.id);
        return {
          ...p,
          // Lo que marketing haya tocado manda sobre lo que se compiló.
          estado: vivo?.estado || p.estado,
          descripcion: vivo?.descripcion || p.descripcion,
          comercial: {
            ...p.comercial,
            precioDesde: vivo?.precio_desde ?? p.comercial.precioDesde,
            precioHasta: vivo?.precio_hasta ?? p.comercial.precioHasta,
            moneda: vivo?.moneda || p.comercial.moneda,
            financiamiento: vivo?.financiamiento || p.comercial.financiamiento,
            rangoAreas: vivo?.area_rango || p.comercial.rangoAreas,
          },
          // El plano dice qué lotes hay; la base, cuáles siguen libres.
          // Un proyecto sin filas en la base es uno que nunca se activó:
          // vale el estado del plano, que es lo que ve el cliente.
          lotes: p.lotes
            ? p.lotes.map((l) => {
                const f = estados?.get(l.id);
                return f ? { ...l, estado: f.estado } : l;
              })
            : null,
          oculto: Boolean(vivo?.oculto),
        };
      })
      // Oculto en el panel es oculto también para la IA: si el cliente no
      // puede verlo en la app, no se le ofrece por chat.
      .filter((p) => !p.oculto && p.estado !== "PRIVATE" && p.estado !== "ARCHIVED");

    return { ...base, proyectos };
  })();

  try {
    const datos = await enVuelo;
    cache = { cuando: Date.now(), datos };
    return datos;
  } finally {
    enVuelo = null;
  }
}

/** Sólo para las pruebas y para forzar una relectura. */
export function olvidarCatalogo(): void {
  cache = null;
  enVuelo = null;
}

/**
 * Quita del prompt de la cuenta el catálogo que pegaba el script viejo
 * (`scripts/ia-conocimiento.mjs` de la Golden App, entre dos marcas).
 *
 * Mientras ese script fue la única forma de que la IA supiera los
 * precios, tenía sentido. Ahora el catálogo se lee en vivo, y dejar los
 * dos sería darle al modelo dos listas de precios distintas — la de hoy y
 * la del día que alguien corrió el script por última vez. Sólo se quita
 * cuando hay catálogo en vivo: si la app no contesta, el pegado es
 * justamente la red de seguridad. Lo que la gente escribió FUERA de las
 * marcas no se toca nunca.
 */
export function sinCatalogoPegado(prompt: string | null): string | null {
  if (!prompt) return prompt;
  const limpio = prompt.replace(/<<<\s*CATÁLOGO AL DÍA[\s\S]*?<<<\s*FIN DEL CATÁLOGO\s*>>>/g, "").trim();
  return limpio || null;
}

const ESTADO_EN_PALABRAS: Record<string, string> = {
  ACTIVE: "en venta",
  COMING_SOON: "próximamente",
  SOLD_OUT: "vendido",
};

const dinero = (n: number, moneda = "PEN") =>
  `${moneda === "PEN" ? "S/" : moneda} ${Math.round(n).toLocaleString("es-PE")}`;

/** "120, 150 y 200 m²" — los tamaños que de verdad quedan, sin repetir. */
function tamanos(areas: number[]): string {
  const unicas = [...new Set(areas.map((a) => Math.round(a)))].sort((a, b) => a - b);
  if (!unicas.length) return "";
  if (unicas.length <= 4) return `${unicas.join(", ")} m²`;
  return `de ${unicas[0]} a ${unicas[unicas.length - 1]} m²`;
}

/**
 * El catálogo en texto, para meterlo en las instrucciones de la IA.
 *
 * De los lotes se dan cifras, no listas: nadie pregunta por el lote D-14,
 * preguntan "¿qué te queda de 200 metros?". El recuento por manzana es lo
 * que permite contestar eso sin inventar y sin volcar cuatrocientas
 * líneas en el prompt.
 */
export function catalogoEnTexto(catalogo: CatalogoDeGolden): string {
  const hoy = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  const bloques = catalogo.proyectos.map((p) => {
    const c = p.comercial;
    const lineas: string[] = [];
    const donde = [p.donde.direccion, p.donde.distrito, p.donde.ciudad].filter(Boolean).join(", ");
    const tipo =
      p.categoria === "lotes"
        ? "lotes de terreno"
        : p.categoria === "casa"
          ? "casa"
          : p.categoria === "residencial"
            ? "departamentos"
            : p.categoria || "proyecto";

    lineas.push(`### ${p.nombre}${p.nombreCorto ? ` (${p.nombreCorto})` : ""}`);
    lineas.push(`${tipo} · ${ESTADO_EN_PALABRAS[p.estado] || p.estado}${donde ? ` · ${donde}` : ""}`);
    if (p.lema) lineas.push(p.lema);

    if (c.precioDesde) {
      const hasta = c.precioHasta && c.precioHasta !== c.precioDesde ? ` hasta ${dinero(c.precioHasta, c.moneda)}` : "";
      lineas.push(`Precio: desde ${dinero(c.precioDesde, c.moneda)}${hasta}.`);
    } else {
      lineas.push("Precio: no publicado — dilo así, no lo inventes.");
    }
    if (c.rangoAreas) lineas.push(`Área: ${c.rangoAreas}.`);
    if (c.dormitorios) lineas.push(`Dormitorios: ${c.dormitorios}.`);
    if (c.financiamiento) lineas.push(`Financiamiento: ${c.financiamiento}.`);
    if (c.inicialDesde) lineas.push(`Inicial desde ${dinero(c.inicialDesde, c.moneda)}.`);
    if (c.cuotaDesde) {
      lineas.push(`Cuotas desde ${dinero(c.cuotaDesde, c.moneda)}${c.plazoMeses ? ` a ${c.plazoMeses} meses` : ""}.`);
    }

    if (p.lotes?.length) {
      const libres = p.lotes.filter((l) => l.estado === "libre");
      lineas.push(
        `Lotes: ${libres.length} libres de ${p.lotes.length}${
          libres.length ? `, ${tamanos(libres.map((l) => l.area ?? 0).filter(Boolean))}` : ""
        }.`,
      );
      if (libres.length) {
        const porMz = new Map<string, number[]>();
        for (const l of libres) {
          const mz = l.mz || "—";
          if (!porMz.has(mz)) porMz.set(mz, []);
          if (l.area) porMz.get(mz)!.push(l.area);
        }
        const detalle = [...porMz.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([mz, areas]) => `Mz ${mz}: ${areas.length}${areas.length ? ` (${tamanos(areas)})` : ""}`)
          .join(" · ");
        lineas.push(`Libres por manzana: ${detalle}.`);
      }
    }

    if (p.unidades?.length) {
      const enVenta = p.unidades.filter((u) => u.disponible);
      lineas.push(
        enVenta.length
          ? `Unidades en venta: ${enVenta
              .map((u) => `${u.nombre} (${u.area} m²${u.precio ? `, ${dinero(u.precio)}` : ""})`)
              .join("; ")}.`
          : "No quedan unidades en venta.",
      );
    }

    if (p.puntosVenta.length) lineas.push(`Por qué gusta: ${p.puntosVenta.slice(0, 6).join("; ")}.`);
    if (p.descripcion) lineas.push(p.descripcion);
    return lineas.join("\n");
  });

  return [
    `## CATÁLOGO DE GOLDEN HABITAT (leído de la app el ${hoy})`,
    "Esto es lo que Golden vende hoy y son los ÚNICOS precios y disponibilidades que puedes decir. Sale de la misma app que ve el cliente, así que si aquí no está, no existe: no lo inventes ni lo deduzcas.",
    "Con los lotes, habla de cuántos quedan y de qué tamaño. No confirmes un lote concreto por su código: eso lo verifica el asesor en la cita, porque cambia a lo largo del día.",
    "Nunca ofrezcas descuentos ni negocies el precio.",
    "",
    ...bloques,
  ].join("\n\n");
}
