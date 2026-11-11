// Lógica pura del marco de las apps de área (golden-shell): qué sección está
// activa según la ruta y qué subtítulo lleva la marca. Con pruebas.

export interface SeccionDef {
  href: string;
  /** Etiqueta corta (barra inferior del celular y título de la cabecera). */
  etiqueta: string;
  /** Etiqueta larga (barra lateral de la laptop). */
  largo: string;
  /** true: solo esa ruta exacta (la raíz de la app no puede quedar activa en todas). */
  exacta?: boolean;
  /** Otros prefijos que cuelgan de esta sección (ej. la ficha de un cliente). */
  tambien?: readonly string[];
}

const dentroDe = (path: string, base: string) => path === base || path.startsWith(base + "/");

export function seccionActiva<T extends SeccionDef>(pathname: string, secciones: readonly T[]): T | null {
  for (const s of secciones) {
    if (pathname === s.href) return s;
    if (s.tambien?.some((p) => pathname.startsWith(p))) return s;
    if (!s.exacta && dentroDe(pathname, s.href)) return s;
  }
  return null;
}

/** La cuenta de Golden se reconoce por el nombre de la cuenta o de su marca. */
export function esGolden(accountName?: string | null, brandName?: string | null): boolean {
  return /golden/i.test(accountName ?? "") || /golden/i.test(brandName ?? "");
}

/** Subtítulo dorado bajo el nombre de la app: solo en Golden; en otras cuentas, nada. */
export function subtituloApp(accountName?: string | null, brandName?: string | null): string | null {
  return esGolden(accountName, brandName) ? "GOLDEN · DREAM HABITAT" : null;
}
