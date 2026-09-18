// ============================================================
// Archivos que el cliente manda por el chat de la app.
//
// Van al bucket PRIVADO `client-docs` (042): son DNIs, contratos, fotos
// de un voucher. Nunca a `chat-media`, que es público porque Meta tiene
// que poder descargarlo.
//
// El mensaje guarda como `media_url` una dirección del propio CRM
// (`/api/chat-files?p=…`) que sólo entrega el archivo a quien puede verlo:
// alguien del equipo de esa cuenta, o el mismo cliente.
// ============================================================

export const BUCKET_CLIENTE = "client-docs";
export const MAXIMO_ADJUNTO = 10 * 1024 * 1024;
export const TIPOS_ADJUNTO = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

/** Ruta del objeto: la cuenta y el contacto van en ella, y son lo que se comprueba al servirlo. */
export function rutaDeAdjunto(accountId: string, contactId: string, ext: string): string {
  return `account-${accountId}/chat/${contactId}/${crypto.randomUUID()}.${ext}`;
}

export function urlDeAdjunto(ruta: string): string {
  return `/api/chat-files?p=${encodeURIComponent(ruta)}`;
}

/** `account-<cuenta>/chat/<contacto>/<archivo>` → sus partes, o null si no tiene esa forma. */
export function partesDeRuta(ruta: string): { accountId: string; contactId: string } | null {
  const m = /^account-([0-9a-f-]{36})\/chat\/([0-9a-f-]{36})\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/i.exec(ruta);
  return m ? { accountId: m[1], contactId: m[2] } : null;
}

export function extensionDe(tipo: string, nombre: string): string {
  const porNombre = /\.([a-z0-9]{2,5})$/i.exec(nombre || "")?.[1];
  if (porNombre) return porNombre.toLowerCase();
  if (tipo === "application/pdf") return "pdf";
  return tipo.split("/")[1] || "jpg";
}
