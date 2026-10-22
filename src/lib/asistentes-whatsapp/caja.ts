// ============================================================
// El modo Golden Caja por WhatsApp: sus instrucciones y sus herramientas.
//
// El webhook corre con la clave de servicio, pero aquí nada lee las tablas
// de caja directo: todo pasa por `cash_as_user` (migración 075), que corre
// las funciones de Golden Caja COMO la persona reconocida. Un encargado ve
// sólo su caja y nadie salta las reglas de la app (límite de gasto grande,
// cajas archivadas, historial inmutable).
//
// Registrar plata es sólo para dueños y nunca es directo: la herramienta
// arma un borrador y lo guarda el botón "Sí, guardar" (ver equipo.ts).
// ============================================================

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CATEGORIAS,
  METODOS,
  hoyEnLima,
  type Borrador,
  type Categoria,
  type Metodo,
  type VistaDelDia,
} from "./texto";

export interface ContextoCaja {
  /** Cliente con clave de servicio: sólo se usa para `cash_as_user` y los borradores. */
  db: SupabaseClient;
  userId: string;
  accountId: string;
  nombre: string;
  esDueno: boolean;
}

export class ErrorCaja extends Error {}

/** Corre una función de Golden Caja como la persona. */
export async function comoLaPersona<T>(ctx: Pick<ContextoCaja, "db" | "userId">, llamada: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await ctx.db.rpc("cash_as_user", { p_user: ctx.userId, p_call: llamada, p_args: args });
  if (error) throw new ErrorCaja(error.message);
  return data as T;
}

export function instruccionesCaja(ctx: ContextoCaja): string {
  const ahora = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
  return [
    `Eres Golden Caja, el asistente de las cajas de Golden Habitat por WhatsApp. Hablas con ${ctx.nombre}, ${ctx.esDueno ? "dueño de caja: ve todas las cajas y puede registrar movimientos" : "encargado: sólo ve su caja y sólo puede consultar"}.`,
    `Ahora en Lima es ${ahora} (hoy es ${hoyEnLima()}).`,
    "Reglas:",
    "- Usa SIEMPRE las herramientas para saldos, movimientos, cierres y reportes. Nunca inventes montos ni movimientos.",
    "- Los montos van con S/ y los días como 'hoy', 'ayer' o '12 de octubre'.",
    "- Responde corto, para leer en el celular: frases breves y listas con '- '. *Negrita* (un asterisco) sólo para lo importante.",
    "- Si piden algo de una caja que no ves, dilo sin dar detalles.",
    ctx.esDueno
      ? "- Para registrar un gasto o un ingreso usa `proponer_movimiento`. Necesitas caja, monto, concepto y cómo se pagó (si no lo dicen, efectivo). Si falta la caja o el monto, pregunta. Si la herramienta pide justificación porque es un gasto grande, pídela en una línea. Después de proponer, di sólo que revise el borrador y toque *Sí, guardar*: un 'sí' escrito NO guarda nada."
      : "- Esta persona no puede registrar movimientos por WhatsApp. Si lo pide, dile que lo haga en la app de Golden Caja.",
    "- Lo que registres queda en el historial de la caja con origen WhatsApp.",
  ].join("\n");
}

const CAJA = { type: "string", description: "Nombre de la caja (Restaurante, Cafetería, La Jato…). Vacío = todas." };
const DIA = { type: "string", description: "Día AAAA-MM-DD en hora de Lima." };

export function herramientasCaja(ctx: ContextoCaja) {
  const consultas = [
    {
      type: "function",
      function: {
        name: "cajas_del_dia",
        description:
          "Cómo va cada caja en un día: saldo, lo que entró y salió, gastos grandes, si cerró (y con qué diferencia) y reposiciones pendientes. Úsala para '¿cómo va la cafetería?', '¿cuánto hay?', '¿cómo fue el día?'.",
        parameters: { type: "object", properties: { dia: { ...DIA, description: "Día AAAA-MM-DD. Vacío = hoy." } }, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "movimientos",
        description:
          "Busca movimientos por fecha (el día en que pasaron), caja, tipo, categoría, monto mínimo o texto del concepto. Trae los totales del filtro y los más recientes.",
        parameters: {
          type: "object",
          properties: {
            caja: CAJA,
            desde: { ...DIA, description: "Desde AAAA-MM-DD. Vacío = hoy." },
            hasta: { ...DIA, description: "Hasta AAAA-MM-DD. Vacío = hoy." },
            tipo: { type: "string", enum: ["gasto", "ingreso"] },
            categoria: { type: "string", enum: Object.keys(CATEGORIAS) },
            monto_minimo: { type: "number", description: "En soles." },
            buscar: { type: "string", description: "Texto del concepto o de a quién se pagó." },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reporte_del_mes",
        description:
          "El reporte de un mes: saldo al empezar y al terminar, ingresos, gastos, pases entre cajas, gastos por categoría y por método, gastos grandes y cierres con diferencia.",
        parameters: {
          type: "object",
          properties: { caja: CAJA, mes: { type: "string", description: "AAAA-MM. Vacío = este mes." } },
          additionalProperties: false,
        },
      },
    },
  ];
  if (!ctx.esDueno) return consultas;
  return [
    ...consultas,
    {
      type: "function",
      function: {
        name: "proponer_movimiento",
        description:
          "Arma el borrador de un gasto o un ingreso para que el dueño lo confirme con el botón. No guarda nada por sí sola.",
        parameters: {
          type: "object",
          properties: {
            caja: { type: "string", description: "Nombre de la caja." },
            tipo: { type: "string", enum: ["gasto", "ingreso"] },
            monto: { type: "number", description: "En soles, por ejemplo 120 o 35.50." },
            concepto: { type: "string", description: "Qué fue, corto: 'Gas', 'Venta de almuerzos'." },
            a_quien: { type: "string", description: "A quién se pagó o de quién vino. Opcional." },
            metodo: { type: "string", enum: Object.keys(METODOS), description: "Cómo se pagó. Por defecto cash (efectivo)." },
            categoria: { type: "string", enum: Object.keys(CATEGORIAS), description: "Sólo para gastos." },
            justificacion: { type: "string", description: "Motivo, obligatorio si el gasto pasa el límite de la caja." },
          },
          required: ["caja", "tipo", "monto", "concepto"],
          additionalProperties: false,
        },
      },
    },
  ];
}

const sinTildes = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Encuentra la caja por su nombre, tolerando tildes y nombres a medias. */
export function buscarCaja<T extends { name: string }>(cajas: T[], nombre: string | undefined): { una?: T; varias?: T[] } {
  if (!nombre?.trim()) return { varias: cajas };
  const q = sinTildes(nombre);
  const exacta = cajas.find((c) => sinTildes(c.name) === q);
  if (exacta) return { una: exacta };
  // "la jato" encuentra "La Jato · Hacienda"; "el restaurante", "Restaurante".
  const palabras = (s: string) => sinTildes(s).split(/[\s·]+/).filter((p) => p.length >= 4);
  const parecidas = cajas.filter(
    (c) => sinTildes(c.name).includes(q) || palabras(c.name).some((p) => palabras(q).includes(p)),
  );
  return parecidas.length === 1 ? { una: parecidas[0] } : { varias: parecidas.length ? parecidas : cajas };
}

const aCentimos = (soles: unknown) => (typeof soles === "number" && Number.isFinite(soles) ? Math.round(soles * 100) : NaN);

type Caja = VistaDelDia["boxes"][number] & { id: string; largeExpenseCents: number };

/** Lo que el modo Caja dejó pendiente en esta vuelta: un borrador para confirmar. */
export interface Propuesta {
  id: string;
  borrador: Borrador;
}

export function ejecutorCaja(ctx: ContextoCaja) {
  let propuesta: Propuesta | null = null;
  let vista: (VistaDelDia & { boxes: Caja[] }) | null = null;
  const cajas = async () => (vista ??= await comoLaPersona<VistaDelDia & { boxes: Caja[] }>(ctx, "overview")).boxes;

  async function cajaPorNombre(nombre: string | undefined) {
    if (!nombre?.trim()) return { id: undefined };
    const r = buscarCaja(await cajas(), nombre);
    if (r.una) return { id: r.una.id, caja: r.una };
    return { error: `No sé cuál caja es "${nombre}".`, opciones: (r.varias ?? []).map((c) => c.name) };
  }

  async function ejecutar(nombre: string, argumentos: string): Promise<unknown> {
    let args: Record<string, unknown> = {};
    try {
      args = argumentos ? JSON.parse(argumentos) : {};
    } catch {
      return { error: "Argumentos inválidos." };
    }
    try {
      switch (nombre) {
        case "cajas_del_dia": {
          const dia = typeof args.dia === "string" && args.dia ? args.dia : hoyEnLima();
          if (dia === hoyEnLima()) return { ...(vista ??= await comoLaPersona(ctx, "overview")) };
          return await comoLaPersona(ctx, "overview", { day: dia });
        }
        case "movimientos": {
          const caja = await cajaPorNombre(args.caja as string | undefined);
          if ("error" in caja) return caja;
          return await comoLaPersona(ctx, "entries", {
            companyId: caja.id,
            from: args.desde,
            to: args.hasta ?? args.desde,
            kind: args.tipo === "gasto" ? "expense" : args.tipo === "ingreso" ? "income" : undefined,
            category: args.categoria,
            minCents: args.monto_minimo === undefined ? undefined : aCentimos(args.monto_minimo),
            text: args.buscar,
            limit: 25,
          });
        }
        case "reporte_del_mes": {
          const caja = await cajaPorNombre(args.caja as string | undefined);
          if ("error" in caja) return caja;
          const mes = typeof args.mes === "string" && /^\d{4}-\d{2}$/.test(args.mes) ? `${args.mes}-01` : undefined;
          const reporte = await comoLaPersona<{ month: string; boxes: Record<string, unknown>[] }>(ctx, "month_report", {
            companyId: caja.id ?? (ctx.esDueno ? undefined : (await cajas())[0]?.id),
            month: mes,
          });
          // Las listas completas de movimientos no caben ni hacen falta para responder.
          return {
            mes: reporte.month,
            cajas: reporte.boxes.map((caja) => ({
              ...Object.fromEntries(Object.entries(caja).filter(([k]) => !["entries", "reversals", "largeExpenses"].includes(k))),
              largeExpenses: (caja.largeExpenses as { amount_cents: number; concept: string; occurred_on: string }[]).map((g) => ({
                amountCents: g.amount_cents,
                concept: g.concept,
                day: g.occurred_on,
              })),
            })),
          };
        }
        case "proponer_movimiento":
          return await proponer(args);
        default:
          return { error: `Herramienta desconocida: ${nombre}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : "No se pudo consultar la caja." };
    }
  }

  async function proponer(args: Record<string, unknown>) {
    if (!ctx.esDueno) return { error: "Sólo los dueños registran movimientos por WhatsApp." };
    const r = buscarCaja(await cajas(), args.caja as string);
    if (!r.una) return { error: `¿En qué caja? No sé cuál es "${args.caja}".`, opciones: (r.varias ?? []).map((c) => c.name) };
    const caja = r.una;
    const kind = args.tipo === "ingreso" ? "income" : "expense";
    const amountCents = aCentimos(args.monto);
    if (!Number.isInteger(amountCents) || amountCents < 1) return { error: "Falta un monto válido." };
    const concept = String(args.concepto ?? "").trim().slice(0, 200);
    if (!concept) return { error: "Falta el concepto." };
    const paymentMethod: Metodo = (args.metodo as string) in METODOS ? (args.metodo as Metodo) : "cash";
    const category: Categoria | null =
      kind === "expense" && (args.categoria as string) in CATEGORIAS ? (args.categoria as Categoria) : null;
    const justification = String(args.justificacion ?? "").trim().slice(0, 300) || null;
    if (kind === "expense" && amountCents > caja.largeExpenseCents && (justification?.length ?? 0) < 10) {
      return {
        falta: "justificacion",
        mensaje: `Es un gasto grande: pasa el límite de ${caja.name}. Pide el motivo (al menos una frase) y vuelve a proponerlo.`,
        limiteCentimos: caja.largeExpenseCents,
      };
    }

    const borrador: Borrador = { caja: caja.name, kind, amountCents, concept, paymentMethod, category, justification };
    const command = {
      companyId: caja.id,
      requestId: randomUUID(),
      kind,
      amountCents,
      concept,
      counterparty: String(args.a_quien ?? "").trim().slice(0, 160) || (kind === "expense" ? "Proveedor" : "Cliente"),
      date: hoyEnLima(),
      paymentMethod,
      category,
      justification,
    };
    const { data, error } = await ctx.db
      .from("whatsapp_team_drafts")
      .insert({ account_id: ctx.accountId, user_id: ctx.userId, command, summary: JSON.stringify(borrador) })
      .select("id")
      .single();
    if (error || !data) return { error: "No pude guardar el borrador. Intenta de nuevo." };
    propuesta = { id: data.id as string, borrador };
    return { ok: true, borrador_listo: true, instruccion: "Dile que revise y toque Sí, guardar." };
  }

  return { ejecutar, propuesta: () => propuesta };
}
