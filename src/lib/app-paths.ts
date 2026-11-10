// Rutas de app a las que se puede volver tras iniciar sesión (parámetro `next`).
// Lo que no esté aquí cae a /dashboard, así `next` no sirve de redirección abierta.
export const APP_PATHS = ["/caja"] as const;

export function safeNextPath(next: string | null): string {
  if (!next) return "/dashboard";
  const ok = [...APP_PATHS, "/dashboard"].some(
    (base) => next === base || next.startsWith(base + "/"),
  );
  return ok ? next : "/dashboard";
}
