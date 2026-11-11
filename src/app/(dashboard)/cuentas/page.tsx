"use client";

// Cuentas del dueño: el árbol por áreas de SU negocio (nunca otra empresa).
// Lo ven el dueño de la cuenta y quienes tienen el área Gerencia; el resto es
// devuelto al panel (y el endpoint responde 403 de todos modos).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Network } from "lucide-react";

import { AccountAreaTree } from "@/components/cuentas/account-area-tree";
import type { MiembroArbol } from "@/lib/areas/arbol";
import type { CuentaDestino } from "@/lib/areas/destinos";

interface Datos {
  account: CuentaDestino & { id: string };
  members: MiembroArbol[];
}

export default function CuentasPage() {
  const router = useRouter();
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/team-tree")
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          router.replace("/dashboard");
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
        if (!cancelled) setDatos(body as Datos);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-black uppercase tracking-wider text-white">
          <Network className="h-5 w-5 text-primary" />
          Cuentas
        </h1>
        <p className="text-sm text-muted-foreground">
          {datos ? datos.account.name : "Tu negocio"}: tu gente por área, si cada área está encendida y a dónde
          entra cada una.
        </p>
      </header>

      {error ? (
        <p className="text-sm text-rose-400">No se pudieron cargar las cuentas: {error}</p>
      ) : !datos ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </p>
      ) : (
        <AccountAreaTree cuenta={datos.account} miembros={datos.members} />
      )}
    </div>
  );
}
