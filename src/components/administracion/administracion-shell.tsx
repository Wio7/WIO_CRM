"use client";

// Marco de la app de Administración: usa el marco común de las apps de Golden
// (golden-shell: laptop con barra lateral, celular con cabecera y barra
// inferior). Aquí solo viven sus 5 secciones. "Caja chica" lleva a /caja.

import type { ReactNode } from "react";
import { FileSpreadsheet, Inbox, Landmark, ListChecks, Wallet } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { APP_ADMINISTRACION_PATHS, CollectionsPathsProvider } from "@/components/collections/base-path";
import { GoldenShell } from "@/components/apps/golden-shell";
import type { SeccionApp } from "@/components/apps/golden-frame";

export const SECCIONES_ADMINISTRACION: readonly SeccionApp[] = [
  { href: "/administracion", etiqueta: "Resumen", largo: "Resumen", icono: Landmark, exacta: true },
  { href: "/administracion/estado-de-cuenta", etiqueta: "Estado", largo: "Estado de cuenta", icono: FileSpreadsheet },
  { href: "/administracion/por-validar", etiqueta: "Validar", largo: "Por validar", icono: ListChecks, tambien: ["/administracion/vouchers"] },
  { href: "/caja", etiqueta: "Caja chica", largo: "Caja chica", icono: Wallet },
  { href: "/administracion/bandeja", etiqueta: "Bandeja", largo: "Te enviaron / Enviados", icono: Inbox },
];

export function AdministracionShell({ children }: { children: ReactNode }) {
  const { isOwner, isSuperAdmin, moduleAccess } = useAuth();
  // Los datos de pagos y la caja de Administración los abre la 092 (módulo cobranzas); sin él la pantalla lo dice.
  const sinDatos = moduleAccess?.cobranzas === false && !isOwner && !isSuperAdmin;

  return (
    <CollectionsPathsProvider value={APP_ADMINISTRACION_PATHS}>
    <GoldenShell
      app="administracion"
      icono={Landmark}
      secciones={SECCIONES_ADMINISTRACION}
      loginPath="/administracion/login"
      equipo="el equipo de administración"
      sinAcceso={sinDatos ? "Sin acceso a los datos de Administración. Pídele al dueño de la cuenta que te asigne el área." : null}
    >
      {children}
    </GoldenShell>
    </CollectionsPathsProvider>
  );
}
