"use client";

// Marco de entrada de las apps de área: decide quién pasa (cargando, sin sesión,
// "Esta app es de otra área") y, si entra, pinta el marco Golden. Cada app
// (Cobranzas ahora; Administración, Marketing, Gerencia y Técnica después)
// solo declara su nombre, su ícono y sus secciones.

import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useAppEntry } from "@/hooks/use-my-area";
import { createClient } from "@/lib/supabase/client";
import { nombreApp } from "@/lib/apps/nombres";
import { subtituloApp } from "@/lib/apps/secciones";
import type { AppKey } from "@/lib/apps/acceso";
import { GoldenBody, GoldenFrame, type SeccionApp } from "@/components/apps/golden-frame";

type Icono = ComponentType<{ className?: string; size?: number }>;
export type AreaApp = Extract<AppKey, "cobranzas" | "marketing" | "gerencia" | "tecnica">;

export interface GoldenShellProps {
  app: AreaApp;
  icono: Icono;
  secciones: readonly SeccionApp[];
  /** Pantalla de login propia de la app (también donde se vuelve al cerrar sesión). */
  loginPath: string;
  /** "el equipo de cobranzas": completa "X es para ...". */
  equipo: string;
  badges?: Record<string, number>;
  /** Cuando es true se muestra este texto en vez del contenido (módulo sin acceso). */
  sinAcceso?: string | null;
  children: ReactNode;
}

function Centrado({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">{children}</div>
  );
}

export function GoldenShell({ app, icono: Icono, secciones, loginPath, equipo, badges, sinAcceso, children }: GoldenShellProps) {
  const { account, user, loading: authLoading, isOwner, isSuperAdmin } = useAuth();
  const { loading, entrada } = useAppEntry(app);
  const pathname = usePathname();
  const nombre = nombreApp(app, account?.name, account?.brand_name);
  // Cierra sesión y vuelve al login de la app (el signOut general iría al /login del ERP).
  const signOut = async () => {
    await createClient().auth.signOut();
    window.location.href = loginPath;
  };

  const envolver = (c: ReactNode) => <GoldenBody app={app}>{c}</GoldenBody>;

  if (authLoading || loading) {
    return envolver(
      <Centrado>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </Centrado>
    );
  }

  if (!user) {
    // El middleware ya manda al login de la app; esto cubre una sesión que caducó con la página abierta.
    return envolver(
      <Centrado>
        <p className="text-sm text-muted-foreground">Tu sesión terminó.</p>
        <Link
          href={`${loginPath}?next=${encodeURIComponent(pathname)}`}
          className="inline-flex min-h-11 items-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground"
        >
          Iniciar sesión
        </Link>
      </Centrado>
    );
  }

  if (entrada && !entrada.ok) {
    return envolver(
      <Centrado>
        <Icono className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-2xl">Esta app es de otra área</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {nombre} es para {equipo}. Tu cuenta tiene otra área asignada.
        </p>
        <Link
          href={entrada.destino.href}
          className="inline-flex min-h-11 items-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground"
        >
          {entrada.destino.etiqueta}
        </Link>
        <button type="button" onClick={signOut} className="min-h-11 text-sm text-muted-foreground underline">
          Cerrar sesión
        </button>
      </Centrado>
    );
  }

  return envolver(
    <GoldenFrame
      app={app}
      nombre={nombre}
      subtitulo={subtituloApp(account?.name, account?.brand_name)}
      icono={Icono}
      secciones={secciones}
      pathname={pathname}
      badges={badges}
      erpHref={isOwner || isSuperAdmin ? "/dashboard" : undefined}
      onSignOut={signOut}
    >
      {sinAcceso ? <p className="py-16 text-center text-sm text-muted-foreground">{sinAcceso}</p> : children}
    </GoldenFrame>,
  );
}
