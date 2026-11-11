"use client";

// Árbol de un negocio por áreas (Gerencia, Ventas, Legal, Cobranzas…): sus
// personas y, por cada área, el botón ERP y el de la app web. Lo comparten la
// vista del super admin (/saas-owner) y la del dueño (/cuentas).
//
// Dos diseños aparte, no uno estirado: en pantalla ancha cada área es una fila
// con los botones a la derecha; en celular es una tarjeta con los botones
// abajo, a lo ancho.

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { Copy, ExternalLink, Layers, LogIn, Smartphone, User } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { armarArbol, type MiembroArbol, type PersonaArbol, type RamaArbol } from "@/lib/areas/arbol";
import type { CuentaDestino } from "@/lib/areas/destinos";

const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  admin: "Administrador",
  agent: "Asesor",
  viewer: "Solo lectura",
};

export interface AccountAreaTreeProps {
  cuenta: CuentaDestino;
  miembros: MiembroArbol[];
  /**
   * Super admin: entra a la cuenta y luego va a la ruta del área. Sin esto
   * (dueño, ya dentro de su cuenta) el botón ERP es un link a la ruta.
   */
  onEntrarErp?: (href: string) => void | Promise<void>;
  /** Ruta ERP que se está abriendo ahora (deshabilita los botones). */
  entrandoHref?: string | null;
  /**
   * Personas del negocio que además tienen una cuenta propia aparte (id de la
   * persona -> su cuenta). Solo la vista del super admin la pasa.
   */
  cuentasAparte?: Map<string, CuentaAparte>;
  /** Botones de esa cuenta aparte (Entrar y su menú). */
  renderCuentaAparte?: (cuenta: CuentaAparte) => ReactNode;
}

export interface CuentaAparte {
  id: string;
  name: string;
}

function origenActual(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.origin;
}

async function copiarLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Link copiado");
  } catch {
    toast.error("No se pudo copiar el link");
  }
}

interface AparteProps {
  cuentasAparte?: Map<string, CuentaAparte>;
  renderCuentaAparte?: (cuenta: CuentaAparte) => ReactNode;
}

function Persona({ p, cuentasAparte, renderCuentaAparte }: { p: PersonaArbol } & AparteProps) {
  const aparte = cuentasAparte?.get(p.id);
  return (
    <li className="flex items-start gap-2 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
      <User className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-white">{p.full_name || p.email || "Sin nombre"}</p>
        {p.email && p.full_name && <p className="truncate text-[11px] text-muted-foreground">{p.email}</p>}
        <div className="mt-1 flex flex-wrap gap-1">
          {p.account_role && (
            <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
              {ROLE_LABEL[p.account_role] ?? p.account_role}
            </span>
          )}
          <span className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">
            {p.estado}
          </span>
          {aparte && (
            <span
              className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title={`Cuenta aparte: ${aparte.name}`}
            >
              Tiene una cuenta aparte
            </span>
          )}
        </div>
      </div>
      {aparte && renderCuentaAparte && <div className="shrink-0">{renderCuentaAparte(aparte)}</div>}
    </li>
  );
}

function Personas({ rama, cuentasAparte, renderCuentaAparte }: { rama: RamaArbol } & AparteProps) {
  if (rama.personas.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {rama.key === "tienda" ? "Módulo de la cuenta, sin personas propias." : "Nadie asignado a esta área."}
      </p>
    );
  }
  return (
    <ul className="grid gap-2 lg:grid-cols-2">
      {rama.personas.map((p) => (
        <Persona key={p.id} p={p} cuentasAparte={cuentasAparte} renderCuentaAparte={renderCuentaAparte} />
      ))}
    </ul>
  );
}

function EstadoArea({ estado }: { estado: RamaArbol["estado"] }) {
  const on = estado === "activa";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
        on
          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-500"
          : "border-rose-500/20 bg-rose-500/10 text-rose-500"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-rose-500"}`} />
      {on ? "Activa" : "Apagada"}
    </span>
  );
}

/** Botones ERP / App web / Copiar link. `ancho` los reparte a lo ancho (celular). */
function Acciones({
  rama,
  ancho,
  onEntrarErp,
  entrandoHref,
}: {
  rama: RamaArbol;
  ancho: boolean;
  onEntrarErp?: AccountAreaTreeProps["onEntrarErp"];
  entrandoHref?: string | null;
}) {
  const apagada = rama.estado === "apagada";
  const ocupado = entrandoHref != null;
  const tam = ancho ? "h-11 w-full rounded-xl" : "h-9 rounded-xl";
  const titleApagada = apagada ? "Este módulo está apagado en la cuenta" : undefined;

  const erp = rama.sinErp ? (
    <Button
      type="button"
      variant="outline"
      className={`${tam} border-white/10`}
      disabled
      title="Esta gente es externa: no tiene acceso al ERP"
    >
      <LogIn className="h-4 w-4" />
      Sin acceso al ERP
    </Button>
  ) : onEntrarErp ? (
    <Button
      type="button"
      variant="outline"
      className={`${tam} border-primary/30 text-primary`}
      disabled={apagada || ocupado}
      title={titleApagada}
      onClick={() => onEntrarErp(rama.erpHref)}
    >
      <LogIn className="h-4 w-4" />
      {entrandoHref === rama.erpHref ? "Entrando…" : "ERP"}
    </Button>
  ) : apagada ? (
    <Button type="button" variant="outline" className={`${tam} border-white/10`} disabled title={titleApagada}>
      <LogIn className="h-4 w-4" />
      ERP
    </Button>
  ) : (
    <Link
      href={rama.erpHref}
      className={`${tam} inline-flex items-center justify-center gap-1.5 whitespace-nowrap border border-primary/30 px-3 text-sm font-medium text-primary transition-colors hover:bg-primary/10`}
    >
      <LogIn className="h-4 w-4" />
      ERP
    </Link>
  );

  const app = rama.app ? (
    <>
      <a
        href={rama.app.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Abrir ${rama.app.nombre} en otra pestaña`}
        className={`${tam} inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-white/10 bg-white/5 px-3 text-sm font-medium text-white transition-colors hover:bg-white/10`}
      >
        <ExternalLink className="h-4 w-4" />
        App web
      </a>
      <Button
        type="button"
        variant="ghost"
        className={`${ancho ? "h-11 w-full" : "h-9"} rounded-xl border border-white/5 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-white`}
        title="Copiar el link de la app (sirve para instalarla en el celular)"
        onClick={() => copiarLink(rama.app!.url)}
      >
        <Copy className="h-4 w-4" />
        Copiar link
      </Button>
    </>
  ) : (
    <Button type="button" variant="outline" className={`${tam} border-white/10`} disabled>
      <Smartphone className="h-4 w-4" />
      App en camino
    </Button>
  );

  return (
    <div className={ancho ? "grid gap-2" : "flex flex-wrap items-center justify-end gap-2"}>
      {erp}
      {app}
    </div>
  );
}

export function AccountAreaTree({
  cuenta,
  miembros,
  onEntrarErp,
  entrandoHref,
  cuentasAparte,
  renderCuentaAparte,
}: AccountAreaTreeProps) {
  const ramas = useMemo(() => armarArbol(miembros, cuenta, origenActual()), [miembros, cuenta]);

  return (
    <div className="space-y-2" data-testid="arbol-cuentas">
      {ramas.map((rama) => (
        <section key={rama.key} className="rounded-2xl border border-white/5 bg-[#0d0d0f]">
          {/* Pantalla ancha: fila con los botones a la derecha. */}
          <div className="hidden items-start gap-4 p-4 md:flex">
            <div className="w-48 shrink-0 space-y-2">
              <p className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
                <Layers className="h-4 w-4 text-primary" />
                {rama.label}
              </p>
              <div className="flex items-center gap-2">
                <EstadoArea estado={rama.estado} />
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {rama.personas.length} {rama.personas.length === 1 ? "persona" : "personas"}
                </span>
              </div>
              {rama.app && <p className="text-[11px] text-muted-foreground">{rama.app.nombre}</p>}
            </div>
            <div className="min-w-0 flex-1">
              <Personas rama={rama} cuentasAparte={cuentasAparte} renderCuentaAparte={renderCuentaAparte} />
            </div>
            <div className="shrink-0">
              <Acciones rama={rama} ancho={false} onEntrarErp={onEntrarErp} entrandoHref={entrandoHref} />
            </div>
          </div>

          {/* Celular: tarjeta apilada con los botones abajo, a lo ancho. */}
          <div className="space-y-3 p-4 md:hidden">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
                <Layers className="h-4 w-4 text-primary" />
                {rama.label}
              </p>
              <EstadoArea estado={rama.estado} />
            </div>
            {rama.app && <p className="text-[11px] text-muted-foreground">{rama.app.nombre}</p>}
            <Personas rama={rama} cuentasAparte={cuentasAparte} renderCuentaAparte={renderCuentaAparte} />
            <Acciones rama={rama} ancho onEntrarErp={onEntrarErp} entrandoHref={entrandoHref} />
          </div>
        </section>
      ))}
    </div>
  );
}
