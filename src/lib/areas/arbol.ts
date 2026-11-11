// Agrupa a las personas de un negocio por área y les pone sus destinos.
// Función pura: la usan las dos vistas (super admin y dueño).

import {
  AREA_KEYS,
  destinoDeArea,
  tiendaDeCuenta,
  type AreaKey,
  type CuentaDestino,
  type Destino,
} from "./destinos";

export interface MiembroArbol {
  id: string;
  full_name: string | null;
  email: string | null;
  account_role: string | null;
  area: string | null;
}

export interface PersonaArbol extends MiembroArbol {
  /** profiles no tiene columna de estado: quien está en la lista está activo. */
  estado: "Activo";
}

export interface RamaArbol extends Destino {
  personas: PersonaArbol[];
}

const esArea = (v: string | null): v is AreaKey =>
  v !== null && (AREA_KEYS as readonly string[]).includes(v) && v !== "sin_area";

/**
 * Ramas en orden fijo (Gerencia … Área técnica), "Tienda" si el módulo está
 * encendido y "Sin área" al final solo si hay gente ahí.
 */
export function armarArbol(miembros: MiembroArbol[], cuenta: CuentaDestino, origen?: string): RamaArbol[] {
  const porArea = new Map<AreaKey, PersonaArbol[]>();
  for (const m of miembros) {
    const key: AreaKey = esArea(m.area) ? m.area : "sin_area";
    const lista = porArea.get(key) ?? [];
    lista.push({ ...m, estado: "Activo" });
    porArea.set(key, lista);
  }

  const ramas: RamaArbol[] = AREA_KEYS.filter((k) => k !== "sin_area").map((k) => ({
    ...destinoDeArea(k, cuenta, origen),
    personas: porArea.get(k) ?? [],
  }));

  const tienda = tiendaDeCuenta(cuenta);
  if (tienda) ramas.push({ ...tienda, personas: [] });

  const sinArea = porArea.get("sin_area");
  if (sinArea?.length) ramas.push({ ...destinoDeArea("sin_area", cuenta, origen), personas: sinArea });

  return ramas;
}
