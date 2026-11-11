"use client";

// Marco de la app de Cobranzas: usa el marco común de las apps de Golden
// (golden-shell: laptop con barra lateral, celular con cabecera y barra
// inferior) con sus 5 secciones. Aquí solo viven lo propio de Cobranzas: la
// insignia de la bandeja y el contexto de rutas de las pantallas reusadas del ERP.

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { CalendarDays, ClipboardList, FileText, HandCoins, Inbox } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useAppEntry } from "@/hooks/use-my-area";
import { createClient } from "@/lib/supabase/client";
import { inboxBadgeCount, listHandoffs } from "@/lib/handoffs/rpc";
import { APP_COBRANZAS_PATHS, CollectionsPathsProvider } from "@/components/collections/base-path";
import { GoldenShell } from "@/components/apps/golden-shell";
import type { SeccionApp } from "@/components/apps/golden-frame";

export const SECCIONES_COBRANZAS: readonly SeccionApp[] = [
  { href: "/cobranzas", etiqueta: "Morosos", largo: "Cuotas y morosos", icono: HandCoins, exacta: true, tambien: ["/cobranzas/cliente/"] },
  { href: "/cobranzas/vouchers", etiqueta: "Vouchers", largo: "Vouchers por revisar", icono: FileText },
  { href: "/cobranzas/gestiones", etiqueta: "Gestiones", largo: "Gestiones", icono: ClipboardList },
  { href: "/cobranzas/reporte", etiqueta: "Del día", largo: "Reporte del día", icono: CalendarDays },
  { href: "/cobranzas/bandeja", etiqueta: "Bandeja", largo: "Te enviaron / Enviados", icono: Inbox },
];

export function CobranzasShell({ children }: { children: ReactNode }) {
  const { isOwner, isSuperAdmin, moduleAccess } = useAuth();
  const { entrada } = useAppEntry("cobranzas");
  const pathname = usePathname();
  const [bandeja, setBandeja] = useState(0);

  const entra = entrada?.ok === true;
  useEffect(() => {
    if (!entra) return;
    let cancelled = false;
    const supabase = createClient();
    Promise.all([listHandoffs(supabase, "cobranzas", "recibidos"), listHandoffs(supabase, "cobranzas", "enviados")])
      .then(([recibidos, enviados]) => {
        if (!cancelled && recibidos.ok) setBandeja(inboxBadgeCount(recibidos.data, enviados.ok ? enviados.data : []));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entra, pathname]);

  // Cobranzas ya abre sus datos con la 084; si la cuenta no tiene el módulo, la pantalla lo dice.
  const sinDatos = moduleAccess?.cobranzas === false && !isOwner && !isSuperAdmin;

  return (
    <CollectionsPathsProvider value={APP_COBRANZAS_PATHS}>
      <GoldenShell
        app="cobranzas"
        icono={HandCoins}
        secciones={SECCIONES_COBRANZAS}
        loginPath="/cobranzas/login"
        equipo="el equipo de cobranzas"
        badges={{ "/cobranzas/bandeja": bandeja }}
        sinAcceso={sinDatos ? "Sin acceso a Cobranzas. Pídele al dueño de la cuenta que te asigne el área." : null}
      >
        {children}
      </GoldenShell>
    </CollectionsPathsProvider>
  );
}
