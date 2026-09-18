// ============================================================
// Las horas libres de un equipo, calculadas cuando alguien pregunta.
//
// No se guardan "huecos" en ninguna tabla: se restan, cada vez, las citas
// ya tomadas de los tramos que cada persona ofrece (`staff_availability`,
// migración 049). Una tabla de huecos habría que mantenerla al día con
// cada cita, cada cancelación y cada cambio de horario, y el día que se
// desincronice le damos una hora a dos clientes.
//
// Perú no cambia la hora en todo el año: UTC-5 fijo. Por eso la
// aritmética de aquí puede ser directa y no necesita una librería de
// zonas horarias. Si algún día Golden vende fuera de Perú, este es el
// archivo que hay que mirar.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

/** Desfase de Lima respecto a UTC, en minutos. Fijo todo el año. */
const LIMA = -300;

/** Duración de una cita y paso entre horas ofrecidas. */
export const PASO_MIN = 30;

export interface Tramo {
  /** Hora local de Lima, "09:30". */
  hora: string;
  /** Instante exacto, en ISO con zona. */
  starts_at: string;
  /** Con quién sería la cita. */
  user_id: string;
}

export interface DiaLibre {
  /** "2026-09-19" en hora de Lima. */
  fecha: string;
  /** "vie 19 de septiembre" */
  etiqueta: string;
  tramos: Tramo[];
}

const dos = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" de hoy en Lima. */
export function hoyEnLima(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Suma días a una fecha "YYYY-MM-DD" sin salirse del calendario. */
function sumarDias(fecha: string, dias: number): string {
  const [a, m, d] = fecha.split("-").map(Number);
  const base = new Date(Date.UTC(a, m - 1, d));
  base.setUTCDate(base.getUTCDate() + dias);
  return `${base.getUTCFullYear()}-${dos(base.getUTCMonth() + 1)}-${dos(base.getUTCDate())}`;
}

/** Día de la semana (0 domingo … 6 sábado) de una fecha de Lima. */
function diaDeLaSemana(fecha: string): number {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}

/** El instante UTC de una hora local de Lima. */
function instante(fecha: string, minutos: number): Date {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d, 0, minutos - LIMA));
}

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function etiquetaDe(fecha: string, hoy: string): string {
  if (fecha === hoy) return "Hoy";
  if (fecha === sumarDias(hoy, 1)) return "Mañana";
  const [, m, d] = fecha.split("-").map(Number);
  return `${DIAS[diaDeLaSemana(fecha)]} ${d} de ${MESES[m - 1]}`;
}

interface FilaDisponibilidad {
  user_id: string;
  weekday: number;
  starts_min: number;
  ends_min: number;
}

interface FilaCita {
  user_id: string;
  starts_at: string;
  minutes: number;
}

/**
 * Los días con horas libres de un grupo de personas.
 *
 * Devuelve sólo los días que tienen algo que ofrecer: una lista con
 * catorce días vacíos no le sirve a nadie, y en el celular es scroll.
 *
 * @param userIds a quiénes mirar. Vacío devuelve vacío: sin nadie
 *   asignado no hay agenda que enseñar, y es mejor decirlo que inventar
 *   horas que nadie va a atender.
 * @param dias cuántos días hacia adelante
 * @param anticipacionMin cuánto tiene que faltar para una hora para que
 *   todavía se pueda tomar (nadie agenda para dentro de cinco minutos)
 */
export async function diasLibres(
  db: SupabaseClient,
  accountId: string,
  userIds: string[],
  dias = 14,
  anticipacionMin = 60,
): Promise<DiaLibre[]> {
  if (!userIds.length) return [];

  const hoy = hoyEnLima();
  const hasta = sumarDias(hoy, dias);

  const [{ data: horarios }, { data: citas }] = await Promise.all([
    db
      .from("staff_availability")
      .select("user_id, weekday, starts_min, ends_min")
      .eq("account_id", accountId)
      .in("user_id", userIds),
    db
      .from("appointments")
      .select("user_id, starts_at, minutes")
      .eq("account_id", accountId)
      .eq("status", "agendada")
      .in("user_id", userIds)
      .gte("starts_at", instante(hoy, 0).toISOString())
      .lte("starts_at", instante(hasta, 0).toISOString()),
  ]);

  const disponibilidad = (horarios ?? []) as FilaDisponibilidad[];
  if (!disponibilidad.length) return [];

  // Un conjunto de "user|instante" ocupado. Con citas de 30 minutos y
  // paso de 30, comparar el inicio basta; para citas más largas se marcan
  // todos los pasos que cubren.
  const ocupado = new Set<string>();
  for (const c of (citas ?? []) as FilaCita[]) {
    const inicio = Date.parse(c.starts_at);
    for (let t = 0; t < Math.max(PASO_MIN, c.minutes); t += PASO_MIN) {
      ocupado.add(`${c.user_id}|${inicio + t * 60_000}`);
    }
  }

  const minimo = Date.now() + anticipacionMin * 60_000;
  const resultado: DiaLibre[] = [];

  for (let i = 0; i < dias; i += 1) {
    const fecha = sumarDias(hoy, i);
    const dia = diaDeLaSemana(fecha);
    const porHora = new Map<string, Tramo>();

    for (const h of disponibilidad) {
      if (h.weekday !== dia) continue;
      for (let min = h.starts_min; min + PASO_MIN <= h.ends_min; min += PASO_MIN) {
        const cuando = instante(fecha, min);
        if (cuando.getTime() < minimo) continue;
        if (ocupado.has(`${h.user_id}|${cuando.getTime()}`)) continue;

        const hora = `${dos(Math.floor(min / 60))}:${dos(min % 60)}`;
        // Si dos asesores tienen la misma hora libre, se ofrece una sola
        // vez: al cliente le da igual con quién, y elegir es trabajo del
        // sistema, no suyo.
        if (!porHora.has(hora)) {
          porHora.set(hora, { hora, starts_at: cuando.toISOString(), user_id: h.user_id });
        }
      }
    }

    if (porHora.size) {
      resultado.push({
        fecha,
        etiqueta: etiquetaDe(fecha, hoy),
        tramos: [...porHora.values()].sort((a, b) => a.hora.localeCompare(b.hora)),
      });
    }
  }

  return resultado;
}

/**
 * A quién le toca atender a este contacto.
 *
 * El que ya paga es de cobranzas; el que todavía mira, de ventas — y si
 * ya tiene una conversación asignada, de esa persona, que es la que lo
 * viene atendiendo. Devuelve la lista de candidatos, en orden: la agenda
 * que se le enseña al cliente es la de ellos.
 */
export async function quienAtiende(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<string[]> {
  const { count } = await db
    .from("payment_plans")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .in("status", ["activo", "pagado"]);
  const esCliente = (count ?? 0) > 0;

  // Quien ya lo atiende manda: el cliente no quiere que lo pasen de mano.
  const { data: conv } = await db
    .from("conversations")
    .select("assigned_agent_id")
    .eq("contact_id", contactId)
    .eq("account_id", accountId)
    .not("assigned_agent_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (conv?.assigned_agent_id) return [conv.assigned_agent_id as string];

  const { data: equipo, error } = await db
    .from("profiles")
    .select("user_id, area, account_role")
    .eq("account_id", accountId);

  if (error || !equipo?.length) return [];

  const area = esCliente ? "cobranzas" : "ventas";
  const conArea = equipo.filter((p) => p.area === area);
  if (conArea.length) return conArea.map((p) => p.user_id as string);

  // Nadie tiene ese cargo todavía: se ofrece la agenda de quien pueda
  // atender, que es mejor que una pantalla vacía.
  return equipo
    .filter((p) => ["owner", "admin", "agent"].includes(p.account_role as string))
    .map((p) => p.user_id as string);
}
