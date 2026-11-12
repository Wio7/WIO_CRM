"use client";

// Carga el mes elegido del estado de cuenta y los pagos del ERP cercanos.
// El mes de arranque es el del último estado de cuenta guardado (o el mes de
// hoy en Lima si todavía no hay ninguno).

import { useCallback, useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { cargarMes, ultimoMesConDatos, type DatosMes } from "@/lib/administracion/datos";
import { mesActualLima } from "@/lib/administracion/formato";

export function useEstadoCuenta() {
  const supabase = useMemo(() => createClient(), []);
  const [mes, setMes] = useState<string | null>(null);
  // Los datos llevan su mes: al cambiar de mes se ven como "cargando" hasta que llegan los nuevos.
  const [cargado, setCargado] = useState<{ mes: string; datos: DatosMes | null; error: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  const recargar = useCallback(() => setTick((t) => t + 1), []);

  // Mes inicial: el del último movimiento guardado.
  useEffect(() => {
    let cancelado = false;
    ultimoMesConDatos(supabase)
      .then((m) => {
        if (!cancelado) setMes((actual) => actual ?? m ?? mesActualLima());
      })
      .catch(() => {
        if (!cancelado) setMes((actual) => actual ?? mesActualLima());
      });
    return () => {
      cancelado = true;
    };
  }, [supabase]);

  useEffect(() => {
    if (!mes) return;
    let cancelado = false;
    cargarMes(supabase, mes)
      .then((r) => {
        if (cancelado) return;
        setCargado("error" in r ? { mes, datos: null, error: r.error } : { mes, datos: r, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelado) setCargado({ mes, datos: null, error: e instanceof Error ? e.message : "No se pudo cargar" });
      });
    return () => {
      cancelado = true;
    };
  }, [supabase, mes, tick]);

  const vigente = cargado && cargado.mes === mes ? cargado : null;
  const datos = vigente?.datos ?? null;
  const error = vigente?.error ?? null;
  const cargando = mes === null || vigente === null;
  return { supabase, mes, setMes, datos, error, cargando, recargar, mesMaximo: mesActualLima() };
}
