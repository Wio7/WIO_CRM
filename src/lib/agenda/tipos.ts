// ============================================================
// Cómo se llama cada tipo de cita cuando se le habla a una persona.
//
// En la base son `videollamada`, `visita` y `llamada`; en un aviso, "tu
// visita es en una hora" suena a que alguien viene a tu casa. La visita es
// el cliente viniendo a la oficina: una cita presencial.
// ============================================================

const NOMBRES: Record<string, string> = {
  videollamada: "videollamada",
  visita: "cita presencial",
  llamada: "llamada",
};

/** "videollamada", "cita presencial" o "llamada", en minúscula. */
export function nombreDeCita(kind: string): string {
  return NOMBRES[kind] ?? "cita";
}

/** Lo mismo con mayúscula inicial, para un título. */
export function tituloDeCita(kind: string): string {
  const n = nombreDeCita(kind);
  return n.charAt(0).toUpperCase() + n.slice(1);
}
