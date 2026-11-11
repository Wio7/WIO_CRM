// Nombre del menú de la caja por cuenta. El personal nunca ve "Wio Suite":
// en Golden se ve "Golden Caja" y en las demás cuentas "Caja chica".
export function cajaMenuLabel(accountName?: string | null, brandName?: string | null): string {
  if (/golden/i.test(accountName ?? "") || /golden/i.test(brandName ?? "")) return "Golden Caja";
  return "Caja chica";
}
