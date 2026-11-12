// Lee el .xls (BIFF) del banco en el navegador con SheetJS (tarball oficial
// 0.20.3): el archivo no sale del equipo hasta que se confirma la importación
// por el RPC de la base. Se carga a demanda (import dinámico) para no sumar
// SheetJS al resto de la app.

import { parsearFilas, type ResultadoLectura } from "./estado-cuenta";

export async function leerArchivoXls(datos: ArrayBuffer, archivo?: string | null): Promise<ResultadoLectura> {
  try {
    const XLSX = await import("xlsx");
    const libro = XLSX.read(datos, { type: "array" });
    const hoja = libro.Sheets[libro.SheetNames[0]];
    if (!hoja) return { ok: false, error: "El archivo no tiene hojas." };
    const filas = XLSX.utils.sheet_to_json<(string | number | null)[]>(hoja, { header: 1, raw: true, defval: null });
    return parsearFilas(filas, archivo);
  } catch {
    return { ok: false, error: "No se pudo leer el archivo. Sube el estado de cuenta .xls tal como lo descargas del banco." };
  }
}
