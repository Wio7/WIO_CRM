// Módulos del dashboard (núcleo del ERP de Wio).
//
// Cada cuenta guarda la lista de módulos que tiene APAGADOS
// (accounts.disabled_modules, migración 066). Un módulo se identifica por
// su prefijo de ruta. Vacío = la cuenta ve todo.
//
// Este archivo es el registro único: de aquí salen el menú (agrupado por
// área), el diálogo de módulos del super admin y las plantillas por rubro.
// Para sumar un módulo nuevo del ERP (Cobranzas, Personal...), se agrega
// una fila a MODULES y, si aplica, a las plantillas.

/** Rutas que nunca se apagan: sin ellas no se puede entrar ni configurar. */
const ALWAYS_ON = ["/dashboard", "/settings", "/saas-owner"];

export type ModuleArea =
  | "comunicacion"
  | "ventas"
  | "finanzas"
  | "agenda"
  | "automatizacion";

/** Áreas del ERP, en el orden en que salen en el menú. */
export const MODULE_AREAS: ReadonlyArray<{ key: ModuleArea; label: string }> = [
  { key: "comunicacion", label: "Comunicación" },
  { key: "ventas", label: "Ventas" },
  { key: "finanzas", label: "Cobranzas y caja" },
  { key: "agenda", label: "Agenda" },
  { key: "automatizacion", label: "Automatización e IA" },
];

export interface ModuleDef {
  href: string;
  label: string;
  area: ModuleArea;
  /** Módulos que este necesita encendidos para funcionar. */
  requires?: readonly string[];
}

/** Registro de módulos (mismo orden que el menú). */
export const MODULES: readonly ModuleDef[] = [
  { href: "/inbox", label: "Bandeja de Entrada", area: "comunicacion" },
  { href: "/notifications", label: "Notificaciones", area: "comunicacion" },
  { href: "/broadcasts", label: "Difusiones y plantillas", area: "comunicacion" },
  { href: "/calls", label: "Llamadas", area: "comunicacion" },
  { href: "/dialer", label: "Marcador", area: "comunicacion" },
  { href: "/contacts", label: "Contactos", area: "ventas" },
  { href: "/pipelines", label: "Embudos de Venta", area: "ventas" },
  { href: "/projects", label: "Proyectos", area: "ventas" },
  { href: "/reservations", label: "Separaciones", area: "ventas", requires: ["/projects"] },
  { href: "/coupons", label: "Cupones y referidos", area: "ventas" },
  { href: "/payment-plans", label: "Cuotas", area: "finanzas" },
  { href: "/collections", label: "Cobranzas", area: "finanzas", requires: ["/payment-plans"] },
  { href: "/caja", label: "Golden Caja", area: "finanzas" },
  { href: "/calendar", label: "Calendario", area: "agenda" },
  { href: "/automations", label: "Automatizaciones", area: "automatizacion" },
  { href: "/flows", label: "Flujos", area: "automatizacion" },
  { href: "/agents", label: "Agentes IA", area: "automatizacion" },
];

/** Compatibilidad: lista simple href/label que ya usaban otras pantallas. */
export const MODULE_OPTIONS: ReadonlyArray<{ href: string; label: string }> = MODULES.map(
  ({ href, label }) => ({ href, label }),
);

const ALL_HREFS = MODULES.map((m) => m.href);

export function isModuleDisabled(
  pathname: string,
  disabled: readonly string[] | undefined,
): boolean {
  if (!disabled || disabled.length === 0) return false;
  if (ALWAYS_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return false;
  }
  // Un módulo cuyo requerido está apagado también queda apagado, aunque
  // la cuenta se haya configurado antes de que ese módulo existiera.
  // Se suman a lo que ya estaba en la lista (incluso rutas que no están en
  // el registro, que siguen bloqueadas como antes).
  const off = [...disabled, ...withDependencies(disabled)];
  return off.some((m) => pathname === m || pathname.startsWith(`${m}/`));
}

/** Área de una ruta del menú (null si no es un módulo, ej. /dashboard). */
export function moduleArea(href: string): ModuleArea | null {
  return MODULES.find((m) => m.href === href)?.area ?? null;
}

/**
 * Aplica las dependencias a una lista de apagados: si un módulo requerido
 * está apagado, también se apagan los que dependen de él. Devuelve la
 * lista en el orden del registro, sin duplicados ni rutas desconocidas.
 */
export function withDependencies(disabled: Iterable<string>): string[] {
  const off = new Set(disabled);
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of MODULES) {
      if (!off.has(m.href) && m.requires?.some((r) => off.has(r))) {
        off.add(m.href);
        changed = true;
      }
    }
  }
  return ALL_HREFS.filter((href) => off.has(href));
}

/** Al encender un módulo, sus requeridos también se encienden. */
export function enableWithRequirements(disabled: Iterable<string>, href: string): string[] {
  const off = new Set(disabled);
  const stack = [href];
  while (stack.length) {
    const h = stack.pop()!;
    off.delete(h);
    for (const r of MODULES.find((m) => m.href === h)?.requires ?? []) {
      if (off.has(r)) stack.push(r);
    }
  }
  return ALL_HREFS.filter((h) => off.has(h));
}

function offExcept(keep: readonly string[]): string[] {
  const on = new Set(keep);
  return withDependencies(ALL_HREFS.filter((href) => !on.has(href)));
}

/**
 * Plantillas por rubro: al crear o reconfigurar una cuenta, el super admin
 * elige su rubro y se encienden solo los módulos que ese negocio usa.
 */
export const RUBRO_TEMPLATES: ReadonlyArray<{
  key: string;
  label: string;
  /** Módulos apagados que deja la plantilla. */
  disabled: readonly string[];
}> = [
  { key: "todo", label: "Todo encendido", disabled: [] },
  {
    key: "inmobiliaria",
    label: "Inmobiliaria",
    disabled: offExcept([
      "/inbox", "/notifications", "/broadcasts", "/calls", "/dialer",
      "/contacts", "/pipelines", "/projects", "/reservations",
      "/payment-plans", "/collections", "/caja", "/calendar", "/automations", "/agents",
    ]),
  },
  {
    // Estudio legal, nutricionista, consultorio: citas, clientes y cuotas.
    key: "servicios",
    label: "Servicios profesionales (legal, salud)",
    disabled: offExcept([
      "/inbox", "/notifications", "/broadcasts", "/contacts", "/pipelines",
      "/payment-plans", "/collections", "/calendar", "/automations", "/agents",
    ]),
  },
  {
    key: "barberia",
    label: "Barbería y estética",
    disabled: offExcept([
      "/inbox", "/notifications", "/broadcasts", "/contacts", "/pipelines",
      "/coupons", "/caja", "/calendar", "/automations", "/agents",
    ]),
  },
  {
    key: "club",
    label: "Club y restaurante",
    disabled: offExcept([
      "/inbox", "/notifications", "/broadcasts", "/contacts", "/pipelines",
      "/coupons", "/payment-plans", "/collections", "/caja", "/calendar", "/automations", "/agents",
    ]),
  },
  {
    key: "campanas",
    label: "Solo campañas",
    disabled: offExcept(["/inbox", "/contacts", "/broadcasts"]),
  },
];

/**
 * "Vista simple": solo bandeja, contactos y difusiones, para quien usa el
 * CRM para mandar campañas (Broker Home). Todo lo demás queda apagado.
 */
export const SIMPLE_VIEW_MODULES: readonly string[] =
  RUBRO_TEMPLATES.find((t) => t.key === "campanas")!.disabled;

/** Plantilla que coincide exactamente con los módulos apagados (o null). */
export function matchingTemplate(disabled: readonly string[] | undefined): string | null {
  const cur = withDependencies(disabled ?? []).join("|");
  return RUBRO_TEMPLATES.find((t) => t.disabled.join("|") === cur)?.key ?? null;
}

/**
 * Sin embudos de venta, el panel de métricas de tratos no dice nada: esas
 * cuentas ven el inicio simple de campañas.
 */
export function isSimpleAccount(disabled: readonly string[] | undefined): boolean {
  return Boolean(disabled?.includes("/pipelines"));
}
