"use client";

import { Lock } from "lucide-react";
import { ProspectosPanel } from "@/components/prospectos/prospectos-panel";
import { useAuth } from "@/hooks/use-auth";

// Solo super admin. La API lo vuelve a comprobar; esto es solo la pantalla.
export default function ProspectosPage() {
  const { isSuperAdmin, profileLoading } = useAuth();
  if (profileLoading) return <p className="p-6 text-muted-foreground">Cargando…</p>;
  if (!isSuperAdmin) {
    return (
      <div className="mx-auto mt-16 max-w-sm space-y-2 text-center">
        <Lock className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Sección no disponible</h2>
      </div>
    );
  }
  return <ProspectosPanel />;
}
