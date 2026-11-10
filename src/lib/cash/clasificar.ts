// Proyecto y rubro de un gasto de caja, y la propuesta automática a partir
// del texto (WhatsApp y formulario). Reglas de palabras clave, sin IA: lo
// que no se puede deducir queda en null ("sin asignar") para completarlo
// después en la app. Sin red ni base de datos.

export const RUBROS = ['personal', 'marketing', 'obra', 'combi', 'proveedores', 'otros'] as const;
export type Rubro = (typeof RUBROS)[number];

export const RUBRO_ETIQUETAS: Record<Rubro, string> = {
  personal: 'Personal',
  marketing: 'Marketing',
  obra: 'Obra',
  combi: 'Combi',
  proveedores: 'Proveedores',
  otros: 'Otros',
};

export function esRubro(valor: unknown): valor is Rubro {
  return typeof valor === 'string' && (RUBROS as readonly string[]).includes(valor);
}

export interface ProyectoOpcion {
  id: string;
  name: string;
}

export interface Propuesta {
  rubro: Rubro | null;
  projectId: string | null;
  projectName: string | null;
}

/** Minúsculas, sin tildes y solo letras y números separados por un espacio. */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Reglas por rubro, en el orden que desempata (combi gana a marketing, etc.).
// Cada regla es una palabra o raíz que debe empezar una palabra del texto.
// "otros" no tiene reglas: nunca se propone, se elige a mano.
const REGLAS: { rubro: Exclude<Rubro, 'otros'>; reglas: RegExp[] }[] = [
  {
    rubro: 'combi',
    reglas: [/\bcombi/, /\bminivan/, /\bgasolina/, /\bcombustible/, /\bpetroleo/, /\bgrifo\b/, /\bpeaje/, /\bmovilidad\b/],
  },
  {
    rubro: 'marketing',
    reglas: [
      /\bvolant/, /\bpauta/, /\bpublicidad/, /\banunci/, /\bbanner/, /\bafiche/, /\bflyer/, /\btrifoli/,
      /\binfluenc/, /\bmarketing/, /\bfacebook/, /\binstagram/, /\btiktok/, /\bads\b/, /\bspot\b/, /\breel/,
    ],
  },
  {
    rubro: 'obra',
    reglas: [
      /\bcemento/, /\bfierro/, /\bvarilla/, /\bladrillo/, /\barena\b/, /\bpiedra/, /\bferreteria/, /\bvolquete/,
      /\bexcavadora/, /\bmaquinaria/, /\btopograf/, /\bobra\b/, /\bconstruccion/, /\balbanil/, /\bpeon\b/,
      /\bmaestro de obra/, /\bnivelacion/, /\bmovimiento de tierra/, /\bagregados?\b/, /\bconcreto/,
    ],
  },
  {
    rubro: 'personal',
    reglas: [
      /\bsueldo/, /\bplanilla/, /\badelanto/, /\bvacaciones/, /\bgratificacion/, /\bcts\b/, /\bbono\b/,
      /\bhonorarios/, /\buniforme/, /\bpersonal\b/, /\bcomision/, /\bsalario/, /\bjornal/,
    ],
  },
  {
    rubro: 'proveedores',
    reglas: [/\bproveedor/, /\bfactura/, /\borden de compra/, /\bcotizacion/],
  },
];

const PALABRAS_VACIAS = new Set(['del', 'de', 'la', 'las', 'los', 'el', 'etapa', 'fase', 'y']);
const ROMANOS: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/** Número de etapa de una palabra: "2", "ii" -> 2. Mayor que 20 no cuenta (suelen ser montos). */
function numeral(palabra: string): number | null {
  if (/^\d{1,2}$/.test(palabra)) {
    const n = Number(palabra);
    return n >= 1 && n <= 20 ? n : null;
  }
  return ROMANOS[palabra] ?? null;
}

interface ProyectoAnalizado {
  proyecto: ProyectoOpcion;
  completo: string;
  cabeza: string;
  base: string[];
  numero: number | null;
}

function analizar(proyecto: ProyectoOpcion): ProyectoAnalizado | null {
  const palabras = normalizar(proyecto.name).split(' ').filter(Boolean);
  const significativas = palabras.filter((p) => !PALABRAS_VACIAS.has(p));
  if (!significativas.length) return null;
  const ultima = significativas[significativas.length - 1];
  const numero = significativas.length >= 2 ? numeral(ultima) : null;
  const base = numero === null ? significativas : significativas.slice(0, -1);
  return { proyecto, completo: palabras.join(' '), cabeza: base[0], base, numero };
}

function proponerProyecto(texto: string, proyectos: ProyectoOpcion[]): ProyectoOpcion | null {
  const analizados = proyectos.map(analizar).filter((p): p is ProyectoAnalizado => p !== null);
  const palabras = texto.split(' ').filter(Boolean);
  const envuelto = ` ${texto} `;

  // 1. El nombre completo escrito tal cual ("las colinas del este etapa i").
  const exactos = analizados.filter((p) => envuelto.includes(` ${p.completo} `));
  if (exactos.length) return exactos.sort((a, b) => b.completo.length - a.completo.length)[0].proyecto;

  // 2. La palabra principal ("colinas") con su número de etapa si hace falta.
  let mejor: { posicion: number; elegido: ProyectoOpcion | null } | null = null;
  for (const cabeza of new Set(analizados.map((p) => p.cabeza))) {
    const posicion = palabras.indexOf(cabeza);
    if (posicion < 0 || cabeza.length < 3) continue;
    const grupo = analizados.filter((p) => p.cabeza === cabeza);
    let elegido: ProyectoOpcion | null = null;
    if (grupo.length === 1) {
      elegido = grupo[0].proyecto;
    } else {
      // El número es la primera palabra con número tras la principal, saltando las del nombre.
      const saltables = new Set([...PALABRAS_VACIAS, ...grupo.flatMap((p) => p.base)]);
      let n: number | null = null;
      for (const palabra of palabras.slice(posicion + 1, posicion + 6)) {
        if (saltables.has(palabra)) continue;
        n = numeral(palabra);
        break;
      }
      if (n !== null) {
        const iguales = grupo.filter((p) => p.numero === n);
        if (iguales.length === 1) elegido = iguales[0].proyecto;
      }
    }
    if (!mejor || posicion < mejor.posicion) mejor = { posicion, elegido };
  }
  return mejor?.elegido ?? null;
}

/** Rubro y proyecto probables de un gasto según su texto (concepto, a quién se pagó…). */
export function proponerClasificacion(texto: string, proyectos: ProyectoOpcion[] = []): Propuesta {
  const limpio = normalizar(texto ?? '');
  const envuelto = ` ${limpio}`;
  let rubro: Rubro | null = null;
  let puntaje = 0;
  for (const { rubro: candidato, reglas } of REGLAS) {
    const aciertos = reglas.filter((r) => r.test(envuelto)).length;
    if (aciertos > puntaje) {
      rubro = candidato;
      puntaje = aciertos;
    }
  }
  const proyecto = limpio ? proponerProyecto(limpio, proyectos) : null;
  return { rubro, projectId: proyecto?.id ?? null, projectName: proyecto?.name ?? null };
}
