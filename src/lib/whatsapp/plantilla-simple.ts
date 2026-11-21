// ============================================================
// Plantilla simple desde la app del cliente: nombre, tipo y texto.
// Se traduce al formato completo del CRM (`TemplatePayload`) con un
// ejemplo por cada {{n}}, que Meta exige para revisarla.
// ============================================================

import { validateTemplatePayload, type TemplatePayload } from "@/lib/whatsapp/template-validators";

/** "Retomar conversación 1" → "retomar_conversacion_1". */
export function nombreDePlantilla(texto: unknown): string {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** Ejemplos para Meta: {{1}} es el nombre del cliente; los demás, genéricos. */
const EJEMPLOS = ["Karina", "lunes 10:00", "120 m²", "S/ 1,000"];

export function pedidoDePlantilla(
  body: Record<string, unknown>,
): { payload: TemplatePayload } | { error: string } {
  const name = nombreDePlantilla(body.nombre);
  if (!name) return { error: "Ponle un nombre a la plantilla." };
  const categoria = String(body.categoria ?? "").toUpperCase();
  if (categoria !== "MARKETING" && categoria !== "UTILITY") {
    return { error: "El tipo tiene que ser Marketing o Utilidad." };
  }
  const texto = String(body.texto ?? "").trim();
  if (!texto) return { error: "Escribe el texto de la plantilla." };

  const variables = [...new Set([...texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const payload: TemplatePayload = {
    name,
    category: categoria === "MARKETING" ? "Marketing" : "Utility",
    language: "es",
    body_text: texto,
    ...(variables.length ? { sample_values: { body: variables.map((_, i) => EJEMPLOS[i] ?? `dato ${i + 1}`) } } : {}),
  };
  try {
    validateTemplatePayload(payload);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "La plantilla no es válida." };
  }
  return { payload };
}
