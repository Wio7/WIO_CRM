"use client";

// Área de quien está dentro (profiles.area) y si puede entrar a una app.
// Lectura de su propia fila de profiles: no hace falta una RPC nueva. Con
// `loading` en true no se decide nada (ni se muestra "otra área").

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { entradaApp, type AppKey, type Entrada } from "@/lib/apps/acceso";

export function useMyArea(): { area: string | null; loading: boolean } {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<{ userId: string | null; area: string | null } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("area")
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setState({ userId, area: (data?.area as string | null | undefined) ?? null });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (authLoading) return { area: null, loading: true };
  if (!userId) return { area: null, loading: false };
  return state?.userId === userId ? { area: state.area, loading: false } : { area: null, loading: true };
}

/** Entrada a una app para quien está dentro (dueño y super admin entran a todas). */
export function useAppEntry(app: AppKey): { loading: boolean; entrada: Entrada | null } {
  const { isOwner, isSuperAdmin, profileLoading } = useAuth();
  const { area, loading } = useMyArea();
  if (loading || profileLoading) return { loading: true, entrada: null };
  return { loading: false, entrada: entradaApp(app, { area, isOwner, isSuperAdmin }) };
}
