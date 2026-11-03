// Módulos del dashboard que una cuenta puede tener apagados
// (accounts.disabled_modules, migración 066). Se identifican por su
// prefijo de ruta. Estas rutas nunca se pueden apagar: sin ellas el
// usuario no puede entrar ni configurar su cuenta.
const ALWAYS_ON = ["/dashboard", "/settings", "/saas-owner"];

export function isModuleDisabled(
  pathname: string,
  disabled: readonly string[] | undefined,
): boolean {
  if (!disabled || disabled.length === 0) return false;
  if (ALWAYS_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return false;
  }
  return disabled.some((m) => pathname === m || pathname.startsWith(`${m}/`));
}

/** Secciones que el super admin puede apagar por cuenta (mismo orden que el menú). */
export const MODULE_OPTIONS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/inbox", label: "Bandeja de Entrada" },
  { href: "/notifications", label: "Notificaciones" },
  { href: "/contacts", label: "Contactos" },
  { href: "/pipelines", label: "Embudos de Venta" },
  { href: "/projects", label: "Proyectos" },
  { href: "/reservations", label: "Separaciones" },
  { href: "/payment-plans", label: "Cuotas" },
  { href: "/caja", label: "Golden Caja" },
  { href: "/calendar", label: "Calendario" },
  { href: "/coupons", label: "Cupones y referidos" },
  { href: "/dialer", label: "Marcador" },
  { href: "/calls", label: "Llamadas" },
  { href: "/broadcasts", label: "Difusiones y plantillas" },
  { href: "/automations", label: "Automatizaciones" },
  { href: "/flows", label: "Flujos" },
  { href: "/agents", label: "Agentes IA" },
];

/**
 * "Vista simple": solo bandeja, contactos y difusiones, para quien usa el
 * CRM para mandar campañas (Broker Home). Todo lo demás queda apagado.
 */
const SIMPLE_KEEP = new Set(["/inbox", "/contacts", "/broadcasts"]);
export const SIMPLE_VIEW_MODULES: readonly string[] = MODULE_OPTIONS.map((m) => m.href).filter(
  (href) => !SIMPLE_KEEP.has(href),
);

/**
 * Sin embudos de venta, el panel de métricas de tratos no dice nada: esas
 * cuentas ven el inicio simple de campañas.
 */
export function isSimpleAccount(disabled: readonly string[] | undefined): boolean {
  return Boolean(disabled?.includes("/pipelines"));
}
