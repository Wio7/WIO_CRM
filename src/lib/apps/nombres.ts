// Nombre de cada app según la cuenta. El personal del cliente nunca ve el
// nombre interno del producto: en Golden se ve "Golden Cobranzas" y en las
// demás cuentas el nombre genérico del área. (La Caja conserva su propio
// cajaMenuLabel en src/lib/cash/menu.ts.)

const AREA: Record<"cobranzas" | "administracion" | "marketing" | "gerencia" | "tecnica", { golden: string; generico: string }> = {
  cobranzas: { golden: "Golden Cobranzas", generico: "Cobranzas" },
  administracion: { golden: "Golden Administración", generico: "Administración" },
  marketing: { golden: "Golden Marketing", generico: "Marketing" },
  gerencia: { golden: "Golden Gerencia", generico: "Gerencia" },
  tecnica: { golden: "Golden Área técnica", generico: "Área técnica" },
};

export function nombreApp(
  app: keyof typeof AREA,
  accountName?: string | null,
  brandName?: string | null,
): string {
  const esGolden = /golden/i.test(accountName ?? "") || /golden/i.test(brandName ?? "");
  return esGolden ? AREA[app].golden : AREA[app].generico;
}
