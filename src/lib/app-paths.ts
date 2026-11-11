// Rutas de app a las que se puede volver tras iniciar sesión (parámetro `next`).
// Lo que no esté aquí cae a /dashboard, así `next` no sirve de redirección abierta.
// Cada app nueva (Fase F) se suma aquí y en APP_LOGINS si tiene login propio.
export const APP_PATHS = ["/caja", "/collections", "/cobranzas"] as const;

/** Apps con pantalla de login propia dentro de su scope (en Android no se abre con barras de navegador). */
const APP_LOGINS: Record<string, string> = {
  "/cobranzas": "/cobranzas/login",
};

/** Archivos de una app que se abren sin sesión: su login, su manifiesto y sus íconos. */
const APP_PUBLIC = ["/cobranzas/login", "/cobranzas/manifest.webmanifest"];
/** Carpetas públicas de una app (íconos). */
const APP_PUBLIC_DIRS = ["/cobranzas/icono/"];

/** Rutas que piden sesión (se compara por prefijo, como siempre). */
const PROTECTED_PREFIXES = [
  "/dashboard", "/inbox", "/contacts", "/pipelines", "/broadcasts", "/automations", "/settings",
  "/caja", "/collections", "/cobranzas",
];

const dentroDe = (path: string, base: string) => path === base || path.startsWith(base + "/");

export function isAppPublicPath(pathname: string): boolean {
  return APP_PUBLIC.includes(pathname) || APP_PUBLIC_DIRS.some((d) => pathname.startsWith(d));
}

export function isProtectedPath(pathname: string): boolean {
  if (isAppPublicPath(pathname)) return false;
  return PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Login al que se manda a quien llega sin sesión a `pathname`. */
export function appLoginPath(pathname: string): string {
  const base = Object.keys(APP_LOGINS).find((b) => dentroDe(pathname, b));
  return base ? APP_LOGINS[base] : "/login";
}

export function safeNextPath(next: string | null, fallback = "/dashboard"): string {
  if (!next) return fallback;
  // Nunca volver a una pantalla de login: con sesión abierta rebotaría en bucle.
  const ruta = next.split(/[?#]/)[0];
  if (Object.values(APP_LOGINS).includes(ruta) || ruta === "/login") return fallback;
  const ok = [...APP_PATHS, "/dashboard"].some((base) => dentroDe(next, base));
  return ok ? next : fallback;
}
