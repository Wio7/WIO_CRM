"use client";

// Árbol por áreas de un negocio dentro del panel del super admin. Lee la gente
// de /api/admin/accounts/[id]/members y deja que "ERP" entre a la cuenta y
// abra el módulo del área (switchPlatformAccount con destino).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { AccountAreaTree, type CuentaAparte } from "@/components/cuentas/account-area-tree";
import type { MiembroArbol } from "@/lib/areas/arbol";
import { separarCuentasAparte } from "@/lib/areas/cuentas-aparte";
import type { CuentaDestino } from "@/lib/areas/destinos";

export function AccountAreaTreeAdmin({
  cuenta,
  accountId,
  onEntrar,
  cuentasHijas,
  onMiembros,
  renderCuentaAparte,
}: {
  cuenta: CuentaDestino;
  accountId: string;
  /** Entra a la cuenta y va a la ruta (el padre llama a switchPlatformAccount). true = entró. */
  onEntrar: (accountId: string, destino: string) => Promise<boolean>;
  /** Cuentas que cuelgan del negocio: las que se llaman como el correo de alguien de dentro se atan a esa persona. */
  cuentasHijas?: CuentaAparte[];
  /** Avisa al padre de la gente cargada (null si falló) para que filtre "Otras cuentas del negocio". */
  onMiembros?: (miembros: MiembroArbol[] | null) => void;
  /** Botones de la cuenta aparte de una persona (Entrar y su menú). */
  renderCuentaAparte?: (cuenta: CuentaAparte) => ReactNode;
}) {
  const [miembros, setMiembros] = useState<MiembroArbol[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entrandoHref, setEntrandoHref] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/accounts/${accountId}/members`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
        if (cancelled) return;
        setMiembros(body.members ?? []);
        onMiembros?.(body.members ?? []);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        onMiembros?.(null);
      });
    return () => {
      cancelled = true;
    };
    // onMiembros es un setter del padre; solo se vuelve a pedir si cambia la cuenta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const cuentasAparte = useMemo(
    () => (miembros && cuentasHijas ? separarCuentasAparte(miembros, cuentasHijas).porPersona : undefined),
    [miembros, cuentasHijas],
  );

  if (error) return <p className="text-xs text-rose-400">No se pudo cargar el equipo: {error}</p>;
  if (!miembros) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando equipo…
      </p>
    );
  }
  return (
    <AccountAreaTree
      cuenta={cuenta}
      miembros={miembros}
      entrandoHref={entrandoHref}
      cuentasAparte={cuentasAparte}
      renderCuentaAparte={renderCuentaAparte}
      onEntrarErp={async (href) => {
        setEntrandoHref(href);
        // Si entra, la pagina se recarga; si falla, se liberan los botones.
        if (!(await onEntrar(accountId, href))) setEntrandoHref(null);
      }}
    />
  );
}
