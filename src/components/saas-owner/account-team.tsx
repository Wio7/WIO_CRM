"use client";

// Personas que entran a una cuenta, mostradas al desplegar su negocio en el
// panel Cuentas. Lee /api/admin/accounts/[id]/members (solo super admin).

import { useEffect, useState } from "react";
import { Loader2, User } from "lucide-react";

interface TeamMember {
  id: string;
  full_name: string | null;
  email: string | null;
  account_role: string | null;
  area: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  admin: "Administrador",
  agent: "Asesor",
  viewer: "Solo lectura",
};

const AREA_LABEL: Record<string, string> = {
  marketing: "Marketing",
  legal: "Legal",
  cobranzas: "Cobranzas",
  ventas: "Jefatura de ventas",
  gerencia: "Gerencia",
  contabilidad: "Contabilidad",
  administracion: "Administración",
  tecnica: "Área técnica",
  promueve: "Promueve (externo)",
};

// Qué app de la familia corresponde a cada área (migración 046): legal va a
// la app legal; marketing y ventas trabajan en la app de ventas.
const AREA_APP: Record<string, RegExp> = {
  legal: /legal/i,
  marketing: /venta/i,
  ventas: /venta/i,
};

/** Apps de una persona: la única del negocio, o la que toca a su área. */
export function appsForMember(area: string | null, businessApps: string[]): string[] {
  if (businessApps.length === 1) return businessApps;
  const pattern = area ? AREA_APP[area] : undefined;
  if (!pattern) return [];
  return businessApps.filter((app) => pattern.test(app));
}

export function AccountTeam({ accountId, apps }: { accountId: string; apps: string[] }) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/accounts/${accountId}/members`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
        if (!cancelled) setMembers(body.members ?? []);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (error) return <p className="text-xs text-rose-400">No se pudo cargar el equipo: {error}</p>;
  if (!members) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando equipo…
      </p>
    );
  }
  if (members.length === 0) return <p className="text-xs text-muted-foreground">Nadie entra todavía a esta cuenta.</p>;

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {members.map((m) => {
        const memberApps = appsForMember(m.area, apps);
        return (
          <li key={m.id} className="flex items-start gap-2 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
            <User className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-semibold text-white">{m.full_name || m.email || "Sin nombre"}</p>
              {m.email && m.full_name && <p className="truncate text-[11px] text-muted-foreground">{m.email}</p>}
              <div className="flex flex-wrap gap-1">
                {m.account_role && (
                  <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                    {ROLE_LABEL[m.account_role] ?? m.account_role}
                  </span>
                )}
                {m.area && (
                  <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                    {AREA_LABEL[m.area] ?? m.area}
                  </span>
                )}
                {memberApps.map((app) => (
                  <span key={app} className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                    {app}
                  </span>
                ))}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
