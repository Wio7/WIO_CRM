// ============================================================
// Traspasos entre áreas (migración 085): tipos y catálogo.
// Las rutas y los permisos viven en la base; esto solo describe qué
// botones mostrar y con qué etiquetas.
// ============================================================

export type HandoffKind = "pase_legal" | "postventa_desde_cobranzas" | "postventa_desde_legal";
export type HandoffModule = "cobranzas" | "legal" | "postventa";
export type HandoffTopic = "ubicacion" | "avance_obra" | "entrega" | "documentos" | "otro";

export const HANDOFF_KINDS: Record<
  HandoffKind,
  { from: HandoffModule; to: HandoffModule; button: string; entityType: "payment_plan" | "contact" }
> = {
  pase_legal: { from: "cobranzas", to: "legal", button: "Pasar a legal", entityType: "payment_plan" },
  postventa_desde_cobranzas: { from: "cobranzas", to: "postventa", button: "Enviar a postventa", entityType: "contact" },
  postventa_desde_legal: { from: "legal", to: "postventa", button: "Enviar a postventa", entityType: "contact" },
};

export const TOPIC_LABELS: Record<HandoffTopic, string> = {
  ubicacion: "Ubicación",
  avance_obra: "Avance de obra",
  entrega: "Entrega",
  documentos: "Documentos",
  otro: "Otro",
};

/** Traspasos que un área puede enviar, en el orden del catálogo. */
export function kindsFrom(module: HandoffModule): HandoffKind[] {
  return (Object.keys(HANDOFF_KINDS) as HandoffKind[]).filter((k) => HANDOFF_KINDS[k].from === module);
}

/** Traspasos que un área puede recibir, en el orden del catálogo. */
export function kindsTo(module: HandoffModule): HandoffKind[] {
  return (Object.keys(HANDOFF_KINDS) as HandoffKind[]).filter((k) => HANDOFF_KINDS[k].to === module);
}
