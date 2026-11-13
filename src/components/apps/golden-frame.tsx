"use client";

// Marco visual común de las apps de área de Golden (estilo Golden Legal).
// Dos diseños distintos, no uno estirado:
//  - Laptop (768 px o más): barra lateral oscura con la marca y las secciones.
//  - Celular: cabecera oscura con la marca y el título de la sección, y barra
//    inferior con ícono + etiqueta y pastilla vino suave en la activa.
// Solo pinta (quien lo use lo envuelve en GoldenBody); el acceso lo decide
// GoldenShell (o la demo, que no tiene sesión).

import { useEffect, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { Download, LogOut } from "lucide-react";

import { PasosInstalar, useInstalarApp } from "@/components/apps/instalar-app";

import { clasesFuentesGolden } from "@/lib/apps/fuentes";
import { seccionActiva, type SeccionDef } from "@/lib/apps/secciones";

import "@/app/apps-golden.css";

type Icono = ComponentType<{ className?: string; size?: number }>;

export interface SeccionApp extends SeccionDef {
  icono: Icono;
}

/**
 * Activa el estilo Golden mientras el marco está montado: marca el body (las
 * variables de shadcn se redefinen ahí, así los diálogos que van por portales
 * también lo heredan), carga las fuentes y fuerza el modo claro del ERP.
 */
function useGoldenBody(app: string) {
  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    const claseFuentes = clasesFuentesGolden.split(" ");
    const modoAntes = html.dataset.mode;
    const eraOscuro = html.classList.contains("dark");
    body.dataset.goldenApp = app;
    body.dataset.app = app;
    body.classList.add(...claseFuentes);
    html.dataset.mode = "light";
    html.classList.remove("dark");
    return () => {
      delete body.dataset.goldenApp;
      delete body.dataset.app;
      body.classList.remove(...claseFuentes);
      if (modoAntes === undefined) delete html.dataset.mode;
      else html.dataset.mode = modoAntes;
      if (eraOscuro) html.classList.add("dark");
    };
  }, [app]);
}

/** Envuelve una pantalla para que lleve el estilo Golden (marca el body mientras esté montada). */
export function GoldenBody({ app, children }: { app: string; children: ReactNode }) {
  useGoldenBody(app);
  return <>{children}</>;
}

export interface GoldenFrameProps {
  nombre: string;
  /** Subtítulo dorado de la marca (solo cuentas Golden); null = ninguno. */
  subtitulo: string | null;
  icono: Icono;
  secciones: readonly SeccionApp[];
  pathname: string;
  /** Número a mostrar en la insignia de una sección (clave = href). */
  badges?: Record<string, number>;
  /** Pie de la barra lateral: enlace al ERP web (dueño / super admin). */
  erpHref?: string;
  onSignOut?: () => void;
  /** Ruta de la app (ej. "/cobranzas"): muestra "Instalar app" con ese scope. */
  instalarScope?: string;
  /** Rótulo de la demostración (en vez de los botones de sesión). */
  rotuloDemo?: string;
  children: ReactNode;
}

export function GoldenFrame({
  nombre,
  subtitulo,
  icono: Icono,
  secciones,
  pathname,
  badges = {},
  erpHref,
  onSignOut,
  instalarScope,
  rotuloDemo,
  children,
}: GoldenFrameProps) {
  const instalarApp = useInstalarApp(instalarScope);
  const activa = seccionActiva(pathname, secciones);
  const titulo = activa?.largo ?? nombre;
  const badge = (href: string) => (badges[href] > 0 ? <span className="gapp-badge">{badges[href]}</span> : null);

  return (
    <div className={`gapp ${clasesFuentesGolden}`}>
      {/* LAPTOP: barra lateral */}
      <aside className="gapp-sidebar">
        <div className="gapp-brand">
          <span className="gapp-mark">
            <Icono size={22} />
          </span>
          <div>
            <div className="gapp-brand-title">{nombre}</div>
            {subtitulo && <span className="gapp-eyebrow">{subtitulo}</span>}
          </div>
        </div>
        <nav className="gapp-nav" aria-label="Secciones">
          {secciones.map((s) => (
            <Link key={s.href} href={s.href} className="gapp-nav-link" aria-current={s === activa ? "page" : undefined}>
              <s.icono size={18} />
              <span>{s.largo}</span>
              {badge(s.href)}
            </Link>
          ))}
        </nav>
        <div className="gapp-foot">
          {erpHref && (
            <Link href={erpHref} className="gapp-foot-link">
              Abrir el ERP web
            </Link>
          )}
          {instalarApp.visible && (
            <button type="button" onClick={instalarApp.instalar} className="gapp-foot-link">
              <Download size={16} /> Instalar app
            </button>
          )}
          {onSignOut && (
            <button type="button" onClick={onSignOut} className="gapp-foot-link">
              <LogOut size={16} /> Cerrar sesión
            </button>
          )}
        </div>
      </aside>

      <div>
        {/* CELULAR: cabecera con marca y título; LAPTOP: título de página en serif */}
        <header className="gapp-topbar">
          <span className="gapp-mark">
            <Icono size={22} />
          </span>
          <div className="gapp-topbar-text">
            <span className="gapp-eyebrow">{nombre}</span>
            <div className="gapp-topbar-title" role="heading" aria-level={1}>{titulo}</div>
          </div>
          <div className="gapp-topbar-actions">
            {rotuloDemo && <span className="gapp-chip-demo gapp-chip-laptop">{rotuloDemo}</span>}
            {instalarApp.visible && (
              <button type="button" onClick={instalarApp.instalar} aria-label="Instalar app" title="Instalar app" className="gapp-icon-btn">
                <Download size={18} />
              </button>
            )}
            {onSignOut && (
              <button type="button" onClick={onSignOut} aria-label="Cerrar sesión" className="gapp-icon-btn">
                <LogOut size={18} />
              </button>
            )}
          </div>
        </header>

        {rotuloDemo && <div className="gapp-demo-strip">{rotuloDemo}</div>}
        <main className="gapp-main">{children}</main>
        <PasosInstalar nombre={nombre} pasos={instalarApp.pasos} onClose={instalarApp.cerrarPasos} />
      </div>

      {/* CELULAR: barra inferior */}
      <nav className="gapp-tabbar" aria-label="Secciones">
        {secciones.map((s) => (
          <Link key={s.href} href={s.href} className="gapp-tab" aria-current={s === activa ? "page" : undefined}>
            <s.icono size={20} />
            {s.etiqueta}
            {badge(s.href)}
          </Link>
        ))}
      </nav>
    </div>
  );
}
