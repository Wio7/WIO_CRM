// Quién entra a qué app (Fase F §4). Separado del acceso a los DATOS, que
// manda la 084 (can_access_module): contabilidad lee pagos pero no entra a la
// app de Cobranzas. Puro y con pruebas; lo reusan las apps que vienen
// (Contabilidad, Marketing, Gerencia, Técnica): basta una fila en APPS.

export type AppKey = "cobranzas" | "administracion" | "caja" | "marketing" | "gerencia" | "tecnica";

export interface AppDef {
  /** Áreas (profiles.area) que entran. Dueño y super admin entran siempre. */
  areas: readonly string[];
  /** Ruta de la app dentro de este repo. */
  ruta: string;
  /**
   * Áreas para las que esta es SU app (a donde se las manda si caen en otra).
   * Si falta, son las mismas de `areas`. Contabilidad entra a Administración
   * pero su app sigue siendo la Caja.
   */
  propia?: readonly string[];
}

export const APPS: Record<AppKey, AppDef> = {
  cobranzas: { areas: ["cobranzas", "gerencia"], ruta: "/cobranzas" },
  // Administración (F5): la Caja Ica. Entra también contabilidad (mismos datos, 092); su app propia sigue siendo la Caja.
  administracion: { areas: ["administracion", "contabilidad"], ruta: "/administracion", propia: ["administracion"] },
  // Contabilidad aún no tiene app propia: su Caja es lo que le corresponde.
  caja: { areas: ["contabilidad", "administracion", "gerencia"], ruta: "/caja" },
  // Aún sin ruta en este repo (F6 a F8): se activan al construirlas.
  marketing: { areas: ["marketing"], ruta: "/marketing" },
  gerencia: { areas: ["gerencia"], ruta: "/gerencia" },
  tecnica: { areas: ["tecnica"], ruta: "/tecnica" },
};

/** Apps que ya existen como ruta en este repo (el resto no se ofrece como destino). */
const EXISTENTES: readonly AppKey[] = ["cobranzas", "administracion", "caja"];

/**
 * Áreas de gente de afuera de la empresa (089): asesores externos que venden
 * por comisión desde la Golden App. No figuran en ninguna app de APPS ni en
 * el ERP web: la base tampoco les abre datos (is_account_member los deja
 * fuera). Se listan aquí para que ninguna app nueva los admita por error.
 */
export const AREAS_EXTERNAS: readonly string[] = ["promueve"];

export const esAreaExterna = (area: string | null): boolean => area !== null && AREAS_EXTERNAS.includes(area);

export interface Viewer {
  /** profiles.area de quien entra (null = sin área). */
  area: string | null;
  isOwner: boolean;
  isSuperAdmin: boolean;
}

export function canEnterApp(app: AppKey, viewer: Viewer): boolean {
  if (esAreaExterna(viewer.area)) return false;
  if (viewer.isOwner || viewer.isSuperAdmin) return true;
  return viewer.area !== null && APPS[app].areas.includes(viewer.area);
}

/** La app de un área, si existe aquí. Para áreas con varias, la primera que exista. */
export function appDeArea(area: string | null): (AppDef & { key: AppKey }) | null {
  if (!area) return null;
  const key = EXISTENTES.find((k) => (APPS[k].propia ?? APPS[k].areas).includes(area));
  return key ? { key, ...APPS[key] } : null;
}

export type Entrada = { ok: true } | { ok: false; destino: { href: string; etiqueta: string } };

/**
 * ¿Entra a esta app? Si no, a dónde se lo manda: a su app si tiene una en
 * este repo; si no, al ERP web (que sigue abierto hasta que su app exista).
 */
export function entradaApp(app: AppKey, viewer: Viewer): Entrada {
  if (canEnterApp(app, viewer)) return { ok: true };
  const suya = appDeArea(viewer.area);
  if (suya && suya.key !== app) return { ok: false, destino: { href: suya.ruta, etiqueta: "Ir a mi app" } };
  return { ok: false, destino: { href: "/dashboard", etiqueta: "Ir al ERP web" } };
}
