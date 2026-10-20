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
