// ============================================================
// Lotes y cuotas para el Asistente Golden: todo lo que es una cuenta
// (estado, precio exacto, cuota) se hace aquí, nunca en el modelo.
//
// · leerCodigoLote: "A12", "Mz A lote 12", "ñ3" → { mz, numero, bis }.
// · buscarLotes: lotes de los planos con su estado vivo y su precio.
// · simularCuotas: lote = (precio financiado − inicial) / meses, sin
//   intereses, como la ficha de la app (src/data/catalogo-ia.js, misma
//   prueba de paridad: 59168 − 3000 en 48 meses = 1170.17). Casa o depa =
//   crédito con cuota fija (método francés) y TEA explícita, como
//   src/pages/simulator.js; sin TEA no se inventa la tasa.
// ============================================================

import type { CatalogoDeGolden, LoteDelPlano, ProyectoDeGolden } from "@/lib/golden/catalogo";

const MAXIMO_EN_LISTA = 25;

/** "S/ 59,168" · "S/ 1,170.17" · "US$ 480". */
export function dinero(n: number, moneda = "PEN"): string {
  const simbolo = moneda === "PEN" ? "S/" : moneda === "USD" ? "US$" : moneda;
  const entero = Math.abs(n - Math.round(n)) < 0.005;
  return `${simbolo} ${n.toLocaleString("es-PE", {
    minimumFractionDigits: entero ? 0 : 2,
    maximumFractionDigits: entero ? 0 : 2,
  })}`;
}

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-̂̄-ͯ]/g, "").normalize("NFC");

/** Lee un código de lote como lo escribe un asesor. Mantiene la Ñ. */
export function leerCodigoLote(texto: string): { mz: string; numero: number; bis: boolean } | null {
  const t = sinTildes(String(texto ?? "").toUpperCase())
    .replace(/\bMANZANA\b|\bMZA?\b\.?/g, " ")
    .replace(/\bLOTE\b|\bLT\b\.?/g, " ")
    .replace(/[,.]/g, " ")
    .trim();
  const m = /^([A-ZÑ]{1,3})\s*-?\s*0*(\d{1,4})\s*(?:-?\s*(BIS))?$/.exec(t);
  return m ? { mz: m[1], numero: Number(m[2]), bis: Boolean(m[3]) } : null;
}

/** El código de un lote del plano ("A-01", "Ñ-03", "A-24-bis", "L-001"). */
function codigoDelPlano(l: LoteDelPlano) {
  return leerCodigoLote(l.id.replace(/-/g, " "));
}

const ROMANOS: Record<string, string> = { "1": "i", "2": "ii", "3": "iii", "4": "iv", "5": "v" };
/** "Colinas 2" y "colinas ii" se buscan igual. */
const nombreBuscable = (s: string) =>
  sinTildes(s.toLowerCase()).replace(/\b([1-5])\b/g, (_, d: string) => ROMANOS[d]).replace(/\s+/g, " ").trim();

export function nombreProyecto(p: ProyectoDeGolden) {
  return `${p.nombre}${p.nombreCorto ? ` (${p.nombreCorto})` : ""}`;
}

/** Los proyectos que coinciden; `null` si se pidió uno y no existe. */
function filtrarProyectos(catalogo: CatalogoDeGolden, buscado?: string): ProyectoDeGolden[] | null {
  const q = nombreBuscable(buscado ?? "");
  if (!q) return catalogo.proyectos;
  const hallados = catalogo.proyectos.filter((p) =>
    nombreBuscable(`${p.nombre} ${p.nombreCorto ?? ""} ${p.id.replace(/-/g, " ")}`).includes(q),
  );
  return hallados.length ? hallados : null;
}

export interface ArgsBuscarLote {
  proyecto?: string;
  manzana?: string;
  lote?: string;
  area_minima?: number;
  area_maxima?: number;
  estado?: string;
}

const ORDEN_ESTADO: Record<string, number> = { libre: 0, solicitado: 1, separado: 2, sin_confirmar: 3, vendido: 4 };

export function buscarLotes(catalogo: CatalogoDeGolden, args: ArgsBuscarLote) {
  const proyectos = filtrarProyectos(catalogo, args.proyecto);
  const conPlano = catalogo.proyectos.filter((p) => p.lotes?.length);
  if (!proyectos) {
    return {
      proyecto_no_encontrado: true as const,
      proyectos_disponibles: conPlano.map(nombreProyecto),
      por_estado: {} as Record<string, number>,
      lotes: [] as ReturnType<typeof filaDeLote>[],
    };
  }

  const pedido = args.lote ? leerCodigoLote(args.lote) : null;
  const mz = args.manzana ? sinTildes(args.manzana.toUpperCase()).replace(/\bMZA?\b\.?|\bMANZANA\b/g, "").trim() : "";
  const estadoPedido = (args.estado ?? "").trim().toLowerCase();

  const hallados: { p: ProyectoDeGolden; l: LoteDelPlano }[] = [];
  for (const p of proyectos) {
    for (const l of p.lotes ?? []) {
      if (pedido) {
        const c = codigoDelPlano(l);
        if (!c || c.mz !== pedido.mz || c.numero !== pedido.numero || c.bis !== pedido.bis) continue;
      } else if (args.lote) {
        if (l.id.toUpperCase() !== args.lote.trim().toUpperCase()) continue;
      }
      if (mz && (l.mz ?? "").toUpperCase() !== mz) continue;
      if (args.area_minima && (l.area ?? 0) < args.area_minima) continue;
      if (args.area_maxima && (l.area ?? 0) > args.area_maxima) continue;
      hallados.push({ p, l });
    }
  }

  const por_estado: Record<string, number> = {};
  for (const { l } of hallados) por_estado[l.estado] = (por_estado[l.estado] ?? 0) + 1;

  // Con un código pedido se devuelve tal cual (aunque esté vendido, y en
  // todos los proyectos que lo tengan). Si no, por defecto los libres.
  let lista = hallados;
  if (estadoPedido && estadoPedido !== "todos") lista = hallados.filter(({ l }) => l.estado === estadoPedido);
  else if (!args.lote && !estadoPedido && hallados.some(({ l }) => l.estado === "libre")) {
    lista = hallados.filter(({ l }) => l.estado === "libre");
  }
  lista = [...lista].sort((a, b) => (ORDEN_ESTADO[a.l.estado] ?? 9) - (ORDEN_ESTADO[b.l.estado] ?? 9));

  return {
    proyecto_no_encontrado: false as const,
    proyectos_buscados: proyectos.filter((p) => p.lotes?.length).map(nombreProyecto),
    total_encontrados: hallados.length,
    por_estado,
    lotes: lista.slice(0, MAXIMO_EN_LISTA).map(({ p, l }) => filaDeLote(p, l)),
    ...(lista.length > MAXIMO_EN_LISTA ? { mostrando: `${MAXIMO_EN_LISTA} de ${lista.length}` } : {}),
  };
}

function filaDeLote(p: ProyectoDeGolden, l: LoteDelPlano) {
  const moneda = l.moneda || p.comercial.moneda || "PEN";
  return {
    proyecto: p.nombreCorto || p.nombre,
    lote: l.id,
    manzana: l.mz,
    area_m2: l.area,
    estado: l.estado,
    precio_lista: l.precio ? dinero(l.precio, moneda) : "consultar",
    precio_contado: l.precioContado ? dinero(l.precioContado, moneda) : null,
    promocion:
      l.promocion && l.estado === "libre"
        ? {
            precio_contado: l.promocion.contado ? dinero(l.promocion.contado, moneda) : null,
            precio_financiado: l.promocion.financiado ? dinero(l.promocion.financiado, moneda) : null,
          }
        : null,
  };
}

// ------------------------------------------------------------
// Cuotas
// ------------------------------------------------------------

/** Lote: lo que queda tras la inicial, en partes iguales, sin intereses. */
export function cuotaLote({ precio, inicial = 0, meses }: { precio: number | null | undefined; inicial?: number; meses: number | null | undefined }): number | null {
  const p = Number(precio);
  const m = Math.round(Number(meses) || 0);
  if (!Number.isFinite(p) || p <= 0 || m <= 0) return null;
  const saldo = p - (Number(inicial) || 0);
  if (saldo <= 0) return null;
  return Math.round((saldo / m) * 100) / 100;
}

/** Crédito con cuota fija (método francés). TEA en %, efectiva anual. */
export function cuotaFrancesa({ capital, meses, tea }: { capital: number; meses: number; tea: number }): number {
  const n = Math.max(1, Math.round(meses));
  const i = Math.pow(1 + tea / 100, 1 / 12) - 1;
  const cuota = i === 0 ? capital / n : (capital * i) / (1 - Math.pow(1 + i, -n));
  return Math.round(cuota * 100) / 100;
}

export interface ArgsSimular {
  proyecto?: string;
  lote?: string;
  precio?: number;
  inicial?: number;
  inicial_porcentaje?: number;
  meses?: number;
  tea?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Simulacion = Record<string, any>;

export function simularCuotas(catalogo: CatalogoDeGolden, args: ArgsSimular): Simulacion {
  // 1. Un lote concreto.
  if (args.lote) {
    const r = buscarLotes(catalogo, { proyecto: args.proyecto, lote: args.lote, estado: "todos" });
    if (r.proyecto_no_encontrado) return { error: "No encontré ese proyecto.", proyectos_disponibles: r.proyectos_disponibles };
    if (!r.lotes.length) return { error: `No encontré el lote ${args.lote}.` };
    if (r.lotes.length > 1) return { error: "Ese código está en varios proyectos: ¿de cuál?", opciones: r.lotes.map((l) => l.proyecto) };
    const fila = r.lotes[0];
    const p = catalogo.proyectos.find((x) => (x.nombreCorto || x.nombre) === fila.proyecto)!;
    const l = p.lotes!.find((x) => x.id === fila.lote)!;
    if (l.estado === "vendido") return { error: `El lote ${l.id} de ${fila.proyecto} está vendido.` };
    if (l.estado === "sin_confirmar") return { error: "No pude confirmar el estado de ese lote ahora; que lo confirme el asesor antes de cotizar." };
    return simularLote(p, l, args);
  }

  // 2. Un proyecto (casa, depa, o lote por precio).
  const proyectos = filtrarProyectos(catalogo, args.proyecto);
  if (!args.proyecto && !args.precio) return { error: "Dime el lote o el proyecto (y el precio si es otro)." };
  if (!proyectos) return { error: "No encontré ese proyecto.", proyectos_disponibles: catalogo.proyectos.map(nombreProyecto) };
  if (proyectos.length > 1 && args.proyecto) return { error: "Hay varios proyectos con ese nombre: ¿cuál?", opciones: proyectos.map(nombreProyecto) };
  const p = proyectos[0];

  if (p.categoria === "lotes") {
    if (!args.precio) return { error: "Para un lote dime cuál (p. ej. A-12) o su precio; el 'desde' del proyecto no es el precio de un lote." };
    return simularLote(p, { id: "(precio indicado)", mz: null, area: null, estado: "libre", precio: args.precio, moneda: p.comercial.moneda }, args);
  }

  // Casa o departamento: crédito hipotecario.
  if (args.tea == null || !Number.isFinite(Number(args.tea))) {
    return { error: "Para una casa o un departamento la cuota depende de la TEA del banco. Pregúntale al asesor qué TEA usar (o 0 si es pago directo sin intereses)." };
  }
  const precio = args.precio ?? p.comercial.precioDesde;
  if (!precio) return { error: "Ese proyecto no tiene precio publicado: dime el precio." };
  const moneda = p.comercial.moneda || "PEN";
  const pct = args.inicial_porcentaje ?? (args.inicial == null ? 20 : null);
  const inicial = args.inicial ?? Math.round((precio * (pct ?? 0)) / 100);
  const meses = Math.round(args.meses ?? 180);
  const capital = precio - inicial;
  if (capital <= 0) return { error: "La inicial cubre todo el precio: no hay cuotas." };
  const cuota = cuotaFrancesa({ capital, meses, tea: Number(args.tea) });
  return {
    tipo: "credito_hipotecario",
    proyecto: nombreProyecto(p),
    precio: dinero(precio, moneda),
    ...(args.precio ? {} : { precio_es: "el 'desde' del proyecto" }),
    inicial: dinero(inicial, moneda),
    meses,
    tea_porcentaje: Number(args.tea),
    cuota: dinero(cuota, moneda),
    total_pagado: dinero(Math.round((cuota * meses + inicial) * 100) / 100, moneda),
    supuestos: [
      ...(args.inicial == null && args.inicial_porcentaje == null ? ["inicial de 20 % (no la dijeron)"] : []),
      ...(args.meses == null ? ["plazo de 15 años (no lo dijeron)"] : []),
      "referencial: sin seguro de desgravamen ni gastos; la TEA final la da el banco",
    ],
  };
}

function simularLote(p: ProyectoDeGolden, l: LoteDelPlano, args: ArgsSimular): Simulacion {
  const f = p.comercial.financiamientoLotes;
  const moneda = l.moneda || p.comercial.moneda || "PEN";
  const precio = args.precio ?? l.precio ?? null;
  if (!precio) return { error: `El lote ${l.id} no tiene precio en la lista: hay que consultarlo.` };
  const inicial = args.inicial ?? f?.inicial ?? p.comercial.inicialDesde ?? 0;
  const meses = args.meses ?? f?.mesesLote ?? null;
  if (!meses) {
    return {
      error: "Este proyecto no tiene el plazo de cuotas configurado en la app: pregúntale al asesor a cuántos meses.",
      financiamiento_del_proyecto: p.comercial.financiamiento,
    };
  }
  const cuota = cuotaLote({ precio, inicial, meses });
  if (cuota == null) return { error: "Con esa inicial no quedan cuotas que pagar." };

  const promo = l.promocion && l.estado === "libre" && !args.precio ? l.promocion : null;
  const cuotaPromo = promo?.financiado ? cuotaLote({ precio: promo.financiado, inicial, meses }) : null;

  return {
    tipo: "lote_sin_intereses",
    proyecto: p.nombreCorto || p.nombre,
    lote: l.id,
    estado: l.estado,
    precio_financiado: dinero(precio, moneda),
    inicial: dinero(inicial, moneda),
    meses,
    cuota: dinero(cuota, moneda),
    sin_intereses: true,
    ...(l.precioContado ? { al_contado: dinero(l.precioContado, moneda), ahorro_al_contado: dinero(precio - l.precioContado, moneda) } : {}),
    ...(promo && cuotaPromo != null
      ? {
          con_promocion: {
            precio_financiado: dinero(promo.financiado!, moneda),
            ...(promo.contado ? { al_contado: dinero(promo.contado, moneda) } : {}),
            cuota: dinero(cuotaPromo, moneda),
          },
        }
      : {}),
    ...(l.estado !== "libre" ? { aviso: `El lote está ${l.estado}: confirmar con el asesor antes de ofrecerlo.` } : {}),
    supuestos: [
      ...(args.inicial == null ? ["inicial mínima del proyecto"] : []),
      ...(args.meses == null ? ["plazo configurado del proyecto"] : []),
    ],
  };
}
