// Dinero como lo escribe Golden (igual que la Caja): "S/ 18,060.00", "US$ 640.00".
// Formato fijo, sin depender del idioma del navegador: formatCurrency del ERP usa el
// idioma de quien lo ejecuta, y una pantalla pintada en el servidor (la demo
// pública) se desajustaba al hidratar; además algunos navegadores no traen los
// datos de "es-PE" y mostraban "18.060 PEN".

const SIMBOLO: Record<string, string> = { PEN: "S/", USD: "US$", EUR: "€" };

const NUMERO = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function dinero(valor: number, moneda: string): string {
  const code = (moneda || "PEN").trim().toUpperCase();
  const monto = Number(valor) || 0;
  const texto = NUMERO.format(Math.abs(monto));
  return `${monto < 0 ? "-" : ""}${SIMBOLO[code] ?? code} ${texto}`;
}
