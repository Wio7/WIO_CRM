// ============================================================
// El día de la combi, tal como lo cuenta el agente. Las salidas y los asientos
// vienen del CRM con la sesión de quien pregunta (combi_mapa decide quién ve
// teléfonos); los horarios fijos, del catálogo que publica la app.
// ============================================================

export interface SalidaDeCombi {
  id: string;
  hora: string;
  proyecto: string;
  capacidad: number | null;
  nota: string | null;
  salio_at: string | null;
  llego_at: string | null;
  visito_at: string | null;
  volvio_at: string | null;
}

export interface AsientoDeCombi {
  numero: number;
  tipo: string;
  nombre: string;
  telefono: string | null;
  asesor_nombre: string | null;
  asistencia: string | null;
}

const CAPACIDAD = 10;
const horaCorta = (hora: string) => hora.slice(0, 5);

function estadoDe(s: SalidaDeCombi): string {
  if (s.volvio_at) return "ya volvió";
  if (s.visito_at) return "de regreso";
  if (s.llego_at) return "en el proyecto";
  if (s.salio_at) return "en camino";
  return "por salir";
}

/** @param fecha "AAAA-MM-DD" en hora de Lima */
export function armarDiaDeCombi(
  fecha: string,
  salidas: SalidaDeCombi[],
  mapas: Map<string, AsientoDeCombi[]>,
  horarios: Record<string, string[]> | undefined,
) {
  const horas = salidas.map((s) => horaCorta(s.hora));
  // Al mediodía para que ninguna zona horaria lo pase a otro día.
  const diaDeLaSemana = new Date(`${fecha}T12:00:00-05:00`).getUTCDay();
  return {
    fecha,
    salidas: salidas.map((s) => {
      const asientos = mapas.get(s.id) ?? [];
      return {
        hora: horaCorta(s.hora),
        proyecto: s.proyecto,
        estado: estadoDe(s),
        capacidad: s.capacidad ?? CAPACIDAD,
        ocupados: asientos.length,
        libres: Math.max(0, (s.capacidad ?? CAPACIDAD) - asientos.length),
        nota: s.nota,
        pasajeros: asientos.map((a) => ({
          asiento: a.numero,
          nombre: a.nombre,
          tipo: a.tipo,
          asesor: a.asesor_nombre,
          telefono: a.telefono,
          asistencia: a.asistencia,
        })),
      };
    }),
    programados_sin_pasajeros: (horarios?.[String(diaDeLaSemana)] ?? []).filter((h) => !horas.includes(h)),
  };
}
