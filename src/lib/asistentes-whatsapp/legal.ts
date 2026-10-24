// ============================================================
// El modo Golden Legal por WhatsApp: sólo consulta.
//
// Lee lo mismo que la app de Golden Legal (legal_snapshot) con la sesión
// de la persona (sesion.ts), así que legal_role decide qué ve. No tiene
// ninguna herramienta que escriba: aprobar o denegar separaciones sigue
// siendo en la app.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ContextoLegal {
  db: SupabaseClient;
  nombre: string;
}

interface Unidad {
  code: string | null;
  manzana: string | null;
  lote: string | null;
  price: number | null;
  projectName: string | null;
}
interface Separacion {
  clientName: string;
  clientDni: string | null;
  advisorName: string;
  totalAmount: number | null;
  currency: string | null;
  status: string;
  notes?: string | null;
  createdAt?: string;
  approvedAt?: string | null;
  units: Unidad[];
  payments?: { amount: number | null; status: string | null }[];
}
interface Expediente {
  code: string;
  clientName: string | null;
  status: string;
  requiredDocs: Record<string, boolean>;
  observations: string | null;
  createdAt: string;
}
interface Contrato {
  contract_type: string;
  status: string;
  buyer_name: string;
  buyer_dni: string | null;
  project_name: string;
  stage_name: string | null;
  unit_code: string | null;
  terms: Record<string, unknown>;
  version: number;
  created_at: string;
}
export interface FotoLegal {
  accountName: string;
  role: string;
  summary: { pendingReservations: number; approvedReservations: number; activeDossiers: number; totalContracts: number };
  pendingReservations: Separacion[];
  approvedReservations: Separacion[];
  dossiers: Expediente[];
  contracts: Contrato[];
}

export async function fotoLegal(db: SupabaseClient): Promise<FotoLegal> {
  const { data, error } = await db.rpc("legal_snapshot");
  if (error) throw new Error(error.message);
  return data as FotoLegal;
}

export function instruccionesLegal(ctx: ContextoLegal): string {
  const ahora = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "full", timeStyle: "short" }).format(
    new Date(),
  );
  return [
    `Eres Golden Legal, el asistente del área legal de Golden Habitat por WhatsApp. Hablas con ${ctx.nombre}. Ahora en Lima es ${ahora}.`,
    "Consultas separaciones de lotes (pendientes, aprobadas), expedientes con sus documentos, contratos y cronogramas.",
    "Reglas:",
    "- Usa SIEMPRE las herramientas. Nunca inventes clientes, lotes, montos ni estados.",
    "- Por WhatsApp sólo se consulta: si piden aprobar, denegar, observar o generar un contrato, di que eso se hace en la app de Golden Legal.",
    "- Responde corto para el celular: listas con '- ', montos con su moneda (S/ o US$), *negrita* (un asterisco) sólo para lo importante.",
    "- Cuida los datos personales: da el DNI sólo si lo piden.",
  ].join("\n");
}

export const HERRAMIENTAS_LEGAL = [
  {
    type: "function",
    function: {
      name: "panorama_legal",
      description:
        "Cómo está el área legal: cuántas separaciones hay pendientes y aprobadas, las pendientes con su cliente, lote, monto y asesor, y los expedientes con documentos faltantes u observaciones.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_cliente_legal",
      description: "Todo lo legal de un cliente: sus separaciones, su expediente y sus contratos o cronogramas. Busca por nombre o DNI.",
      parameters: {
        type: "object",
        properties: { buscar: { type: "string", description: "Nombre o DNI del cliente." } },
        required: ["buscar"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "contratos",
      description: "Los contratos y cronogramas (arras, compromiso, cronograma sin interés, adenda con método francés, minuta), con su estado. Se puede filtrar por estado.",
      parameters: {
        type: "object",
        properties: { estado: { type: "string", enum: ["borrador", "en_revision", "aprobado", "emitido", "anulado"] } },
        additionalProperties: false,
      },
    },
  },
] as const;

const sinTildes = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const lotes = (u: Unidad[]) =>
  u.map((x) => [x.projectName, x.manzana && `Mz ${x.manzana}`, x.lote && `Lt ${x.lote}`].filter(Boolean).join(" ") || x.code);

const separacion = (s: Separacion) => ({
  cliente: s.clientName,
  asesor: s.advisorName,
  monto: s.totalAmount,
  moneda: s.currency,
  lotes: lotes(s.units ?? []),
  pagos: (s.payments ?? []).map((p) => `${p.amount ?? "?"} (${p.status ?? "sin estado"})`),
  desde: s.createdAt ?? s.approvedAt,
  notas: s.notes ?? undefined,
});

const expediente = (d: Expediente) => ({
  codigo: d.code,
  cliente: d.clientName,
  estado: d.status,
  faltan: Object.entries(d.requiredDocs ?? {})
    .filter(([, ok]) => !ok)
    .map(([doc]) => doc),
  observaciones: d.observations,
});

const contrato = (k: Contrato) => ({
  tipo: k.contract_type,
  estado: k.status,
  comprador: k.buyer_name,
  proyecto: [k.project_name, k.stage_name].filter(Boolean).join(" "),
  lote: k.unit_code,
  version: k.version,
  condiciones: k.terms,
  fecha: k.created_at,
});

export function ejecutorLegal(ctx: ContextoLegal) {
  let foto: FotoLegal | null = null;
  const leer = async () => (foto ??= await fotoLegal(ctx.db));

  return async (nombre: string, argumentos: string): Promise<unknown> => {
    let args: Record<string, unknown> = {};
    try {
      args = argumentos ? JSON.parse(argumentos) : {};
    } catch {
      return { error: "Argumentos inválidos." };
    }
    try {
      const f = await leer();
      switch (nombre) {
        case "panorama_legal":
          return {
            resumen: f.summary,
            pendientes: f.pendingReservations.slice(0, 15).map(separacion),
            expedientes_con_pendientes: f.dossiers
              .filter((d) => d.status !== "archivado" && d.status !== "aprobado")
              .slice(0, 15)
              .map(expediente),
          };
        case "buscar_cliente_legal": {
          const q = sinTildes(String(args.buscar ?? "")).trim();
          if (!q) return { error: "Falta el nombre o DNI." };
          const coincide = (nombre: string | null, dni?: string | null) => sinTildes(nombre).includes(q) || (!!dni && dni === q);
          return {
            separaciones_pendientes: f.pendingReservations.filter((s) => coincide(s.clientName, s.clientDni)).map(separacion),
            separaciones_aprobadas: f.approvedReservations.filter((s) => coincide(s.clientName, s.clientDni)).map(separacion),
            expedientes: f.dossiers.filter((d) => coincide(d.clientName)).map(expediente),
            contratos: f.contracts.filter((k) => coincide(k.buyer_name, k.buyer_dni)).map(contrato),
          };
        }
        case "contratos":
          return f.contracts
            .filter((k) => !args.estado || k.status === args.estado)
            .slice(0, 20)
            .map(contrato);
        default:
          return { error: `Herramienta desconocida: ${nombre}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : "No se pudo consultar Golden Legal." };
    }
  };
}

/** La línea con la que saluda el modo Legal. */
export function saludoLegal(nombre: string, f: FotoLegal): string {
  const s = f.summary;
  return [
    `Hola, ${nombre}. En Golden Legal hoy hay:`,
    `- ${s.pendingReservations} separaciones pendientes`,
    `- ${s.approvedReservations} aprobadas`,
    `- ${s.activeDossiers} expedientes activos y ${s.totalContracts} contratos`,
    "",
    "Pregúntame por un cliente, un expediente o un contrato.",
  ].join("\n");
}
