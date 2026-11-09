// Qué pinta la tarjeta de cliente del chat. Sin acceso a cobranzas (084) el
// plan ni se puede leer (RLS), así que "sin acceso" se decide ANTES de mirar
// si hay plan: si no, la tarjeta desaparecería y parecería "no es cliente".
export type EstadoResumen = "oculto" | "sin-acceso" | "completo";

export function estadoResumen(opts: {
  contactId: string | null;
  hayPlan: boolean;
  sinAcceso: boolean;
}): EstadoResumen {
  if (!opts.contactId) return "oculto";
  if (opts.sinAcceso) return "sin-acceso";
  return opts.hayPlan ? "completo" : "oculto";
}
