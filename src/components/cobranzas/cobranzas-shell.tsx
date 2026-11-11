"use client";

// Marco de la app de Cobranzas. Dos diseños distintos, no uno estirado:
//  - Laptop (md+): barra lateral fija con el nombre de la app y las secciones.
//  - Celular: barra superior mínima y navegación inferior con 5 destinos de
//    56 px de alto (los controles de las pantallas suben a 44 px: cobranzas.css).
// Controla quién entra: solo el área cobranzas, gerencia, dueño y super admin.

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, ClipboardList, FileText, HandCoins, Inbox, Loader2, LogOut } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useAppEntry } from "@/hooks/use-my-area";
import { createClient } from "@/lib/supabase/client";
import { nombreApp } from "@/lib/apps/nombres";
import { inboxBadgeCount, listHandoffs } from "@/lib/handoffs/rpc";
import { cn } from "@/lib/utils";
import { APP_COBRANZAS_PATHS, CollectionsPathsProvider } from "@/components/collections/base-path";
import { buttonVariants } from "@/components/ui/button";

import "@/app/cobranzas/cobranzas.css";

const SECCIONES = [
  { href: "/cobranzas", etiqueta: "Morosos", largo: "Cuotas y morosos", icono: HandCoins, exacta: true },
  { href: "/cobranzas/vouchers", etiqueta: "Vouchers", largo: "Vouchers por revisar", icono: FileText, exacta: false },
  { href: "/cobranzas/gestiones", etiqueta: "Gestiones", largo: "Gestiones", icono: ClipboardList, exacta: false },
  { href: "/cobranzas/reporte", etiqueta: "Del día", largo: "Reporte del día", icono: CalendarDays, exacta: false },
  { href: "/cobranzas/bandeja", etiqueta: "Bandeja", largo: "Te enviaron / Enviados", icono: Inbox, exacta: false },
] as const;

function activa(pathname: string, s: (typeof SECCIONES)[number]): boolean {
  // La ficha de un cliente cuelga de la lista de morosos.
  if (s.exacta) return pathname === s.href || pathname.startsWith("/cobranzas/cliente/");
  return pathname === s.href || pathname.startsWith(s.href + "/");
}

export function CobranzasShell({ children }: { children: ReactNode }) {
  const { account, user, loading: authLoading, isOwner, isSuperAdmin, moduleAccess } = useAuth();
  const { loading, entrada } = useAppEntry("cobranzas");
  const pathname = usePathname();
  const nombre = nombreApp("cobranzas", account?.name, account?.brand_name);
  const [bandeja, setBandeja] = useState(0);
  // Cierra sesión y vuelve al login de la app (el signOut general iría al /login del ERP).
  const signOut = async () => {
    await createClient().auth.signOut();
    window.location.href = "/cobranzas/login";
  };

  useEffect(() => {
    document.body.dataset.app = "cobranzas";
    return () => {
      delete document.body.dataset.app;
    };
  }, []);

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

  if (authLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    // El middleware ya manda al login de la app; esto cubre una sesión que caducó con la página abierta.
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">Tu sesión terminó.</p>
        <Link href={`/cobranzas/login?next=${encodeURIComponent(pathname)}`} className={buttonVariants()}>
          Iniciar sesión
        </Link>
      </div>
    );
  }

  if (entrada && !entrada.ok) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <HandCoins className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Esta app es de otra área</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {nombre} es para el equipo de cobranzas. Tu cuenta tiene otra área asignada.
        </p>
        <Link href={entrada.destino.href} className={cn(buttonVariants(), "min-h-11")}>
          {entrada.destino.etiqueta}
        </Link>
        <button type="button" onClick={signOut} className="min-h-11 text-sm text-muted-foreground underline">
          Cerrar sesión
        </button>
      </div>
    );
  }

  // Cobranzas ya abre sus datos con la 084; si la cuenta no tiene el módulo, la pantalla lo dice.
  const sinDatos = moduleAccess?.cobranzas === false && !isOwner && !isSuperAdmin;
  const badge = (n: number) =>
    n > 0 ? <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground">{n}</span> : null;

  return (
    <CollectionsPathsProvider value={APP_COBRANZAS_PATHS}>
      <div className="cobranzas-app min-h-screen bg-background text-foreground">
        {/* LAPTOP: barra lateral */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-card md:flex">
          <div className="flex items-center gap-2 px-5 py-5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <HandCoins className="h-5 w-5" />
            </span>
            <span className="text-base font-semibold leading-tight">{nombre}</span>
          </div>
          <nav className="flex-1 space-y-1 px-3" aria-label="Secciones">
            {SECCIONES.map((s) => (
              <Link
                key={s.href}
                href={s.href}
                aria-current={activa(pathname, s) ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  activa(pathname, s) ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
                )}
              >
                <s.icono className="h-4 w-4" />
                <span className="flex-1">{s.largo}</span>
                {s.href === "/cobranzas/bandeja" && badge(bandeja)}
              </Link>
            ))}
          </nav>
          <div className="space-y-1 border-t border-border p-3 text-sm">
            {(isOwner || isSuperAdmin) && (
              <Link href="/dashboard" className="block rounded-lg px-3 py-2 text-muted-foreground hover:bg-muted">
                Abrir el ERP web
              </Link>
            )}
            <button
              type="button"
              onClick={signOut}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-muted-foreground hover:bg-muted"
            >
              <LogOut className="h-4 w-4" /> Cerrar sesión
            </button>
          </div>
        </aside>

        {/* CELULAR: barra superior mínima */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-card px-4 py-2 md:hidden">
          <span className="flex items-center gap-2 text-base font-semibold">
            <HandCoins className="h-5 w-5 text-primary" /> {nombre}
          </span>
          <button
            type="button"
            onClick={signOut}
            aria-label="Cerrar sesión"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </header>

        <main className="px-4 pb-28 pt-4 md:ml-60 md:px-8 md:pb-10 md:pt-8">
          {sinDatos ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Sin acceso a Cobranzas. Pídele al dueño de la cuenta que te asigne el área.
            </p>
          ) : (
            children
          )}
        </main>

        {/* CELULAR: navegación inferior */}
        <nav
          className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
          aria-label="Secciones"
        >
          {SECCIONES.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              aria-current={activa(pathname, s) ? "page" : undefined}
              className={cn(
                "relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px]",
                activa(pathname, s) ? "font-medium text-primary" : "text-muted-foreground",
              )}
            >
              <s.icono className="h-5 w-5" />
              {s.etiqueta}
              {s.href === "/cobranzas/bandeja" && bandeja > 0 && (
                <span className="absolute right-3 top-1.5">{badge(bandeja)}</span>
              )}
            </Link>
          ))}
        </nav>
      </div>
    </CollectionsPathsProvider>
  );
}
