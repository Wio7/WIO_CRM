// Dinero en formato de Perú, igual en el servidor y en el navegador. formatCurrency
// del ERP usa el idioma de quien lo ejecuta, y en una pantalla que se pinta en el
// servidor (la demo pública) eso causa un desajuste de hidratación.

export function dinero(valor: number, moneda: string): string {
  const code = (moneda || "PEN").trim();
  const monto = Number(valor) || 0;
  try {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency: code, maximumFractionDigits: 0 }).format(monto);
  } catch {
    return `${code} ${new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 }).format(monto)}`;
  }
}
