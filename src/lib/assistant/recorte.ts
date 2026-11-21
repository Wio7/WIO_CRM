// ============================================================
// Lo que devuelve una herramienta, con un tope de tamaño para el modelo.
//
// Antes se cortaba el JSON a 12 000 caracteres a lo bruto: quedaba JSON
// inválido y, en un chat (de viejo a nuevo), se perdían justo los mensajes
// MÁS RECIENTES. Ahora se recortan las listas —el chat por el principio,
// lo demás por el final— y se avisa con `recortado: true`.
// ============================================================

/** Listas ordenadas de viejo a nuevo: se recortan por el principio. */
const DE_VIEJO_A_NUEVO = new Set(["conversacion", "mensajes"]);

export function paraElModelo(datos: unknown, maximo = 12_000): string {
  let texto = JSON.stringify(datos ?? null);
  if (texto.length <= maximo) return texto;
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) {
    return JSON.stringify({ recortado: true, contenido: texto.slice(0, maximo - 60) });
  }

  const copia: Record<string, unknown> = { ...(datos as Record<string, unknown>), recortado: true };
  const listas = Object.keys(copia).filter((k) => Array.isArray(copia[k]) && (copia[k] as unknown[]).length);
  // La lista más larga primero, de a un elemento, hasta que quepa.
  while (listas.length && (texto = JSON.stringify(copia)).length > maximo) {
    listas.sort((a, b) => JSON.stringify(copia[b]).length - JSON.stringify(copia[a]).length);
    const k = listas[0];
    const lista = [...(copia[k] as unknown[])];
    if (DE_VIEJO_A_NUEVO.has(k)) lista.shift();
    else lista.pop();
    copia[k] = lista;
    if (!lista.length) listas.shift();
  }
  texto = JSON.stringify(copia);
  return texto.length <= maximo ? texto : JSON.stringify({ recortado: true, contenido: texto.slice(0, maximo - 60) });
}
