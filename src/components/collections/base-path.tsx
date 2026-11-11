"use client";

// Las pantallas de Cobranzas sirven en dos lugares: el ERP web (/collections)
// y la app propia (/cobranzas). Este contexto dice en cuál están para que sus
// enlaces no se salgan de la app. Sin proveedor = ERP web (comportamiento de siempre).

import { createContext, useContext, type ReactNode } from "react";

export interface CollectionsPaths {
  /** Base de las pantallas: lista, vouchers, bandeja. */
  base: string;
  /** Reporte del día (en el ERP "daily", en la app "reporte"). */
  daily: string;
  /** Ficha de un cliente dentro de la app; null en el ERP (ahí se va a Cuotas). */
  cliente: ((contactId: string) => string) | null;
}

export const ERP_PATHS: CollectionsPaths = { base: "/collections", daily: "/collections/daily", cliente: null };
export const APP_COBRANZAS_PATHS: CollectionsPaths = {
  base: "/cobranzas",
  daily: "/cobranzas/reporte",
  cliente: (id) => `/cobranzas/cliente/${id}`,
};

const Ctx = createContext<CollectionsPaths>(ERP_PATHS);

export function CollectionsPathsProvider({ value, children }: { value: CollectionsPaths; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCollectionsPaths(): CollectionsPaths {
  return useContext(Ctx);
}
