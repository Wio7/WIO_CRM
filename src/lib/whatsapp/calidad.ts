// ============================================================
// Calidad del número de WhatsApp en lenguaje de semáforo.
//
// Meta califica cada número por cómo reaccionan las personas a sus
// mensajes (bloqueos, reportes): GREEN, YELLOW, RED, o UNKNOWN si todavía
// no hay datos. Con rojo sostenido Meta baja el límite o restringe el
// número. Julio (Broker Home) quería verlo antes de cada envío masivo.
// ============================================================

export type Semaforo = "verde" | "amarillo" | "rojo" | "gris";

export function semaforoDe(calidad: string | null | undefined): Semaforo {
  switch (String(calidad ?? "").toUpperCase()) {
    case "GREEN":
    case "HIGH":
      return "verde";
    case "YELLOW":
    case "MEDIUM":
      return "amarillo";
    case "RED":
    case "LOW":
      return "rojo";
    default:
      return "gris";
  }
}

/** TIER_1K → "Hasta 1.000 personas nuevas al día". */
export function limiteEnTexto(tier: string | null | undefined): string | null {
  const t = String(tier ?? "").toUpperCase();
  if (!t) return null;
  if (t === "TIER_UNLIMITED") return "Sin límite de personas nuevas al día";
  const m = /^TIER_(\d+)(K?)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return `Hasta ${n.toLocaleString("es-PE")} personas nuevas al día`;
}
