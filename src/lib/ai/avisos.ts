// ============================================================
// Avisos al cliente cuando el asesor toma la conversación o se la
// devuelve a la IA. Llevan la marca de LA CUENTA: hasta el 2026-11-21
// decían "Golden Habitat" fijo y los clientes de Broker Home (Juliaca)
// recibían "Hola, soy Julio de Golden Habitat".
// ============================================================

/** "Hola, soy Julio de Broker Home 👋 Desde aquí te atiendo yo." */
export function avisoAsesor(nombre: string | null | undefined, marca: string | null | undefined): string {
  const quien = (nombre ?? "").trim() ? `Hola, soy ${(nombre ?? "").trim()}` : "Hola, soy un asesor";
  const de = (marca ?? "").trim() ? ` de ${(marca ?? "").trim()}` : "";
  return `${quien}${de} 👋 Desde aquí te atiendo yo.`;
}

/** Al devolverle la conversación a la IA. */
export function avisoIa(marca: string | null | undefined): string {
  const de = (marca ?? "").trim() ? ` de ${(marca ?? "").trim()}` : "";
  return `Te dejo con la asistente virtual${de}, que te responde al instante a cualquier hora. Si necesitas a una persona, dilo y te paso con un asesor. 🙌`;
}

/**
 * ¿Hay que avisar? Solo si el botón CAMBIA quién contesta. Tocarlo dos
 * veces (o tres, como pasó en Broker Home) mandaba el mismo saludo
 * repetido al cliente en segundos.
 */
export function hayQueAvisar(iaApagadaAntes: boolean | null | undefined, ia: boolean): boolean {
  const apagada = Boolean(iaApagadaAntes);
  return ia ? apagada : !apagada;
}
