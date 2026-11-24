"use client";

import { useEffect } from "react";
import { MODE_STORAGE_KEY, DEFAULT_MODE, isMode } from "@/lib/themes";

/** Estética de Wio Suite en <html>; las cuentas con marca propia conservan la suya. */
export function WioLook({ custom }: { custom: boolean }) {
  useEffect(() => {
    const d = document.documentElement;
    let saved: string | null = null;
    try {
      localStorage.setItem("wacrm.marca", custom ? "propia" : "wio");
      saved = localStorage.getItem(MODE_STORAGE_KEY);
    } catch {
      // Sin almacenamiento: vale para esta visita.
    }
    if (custom) {
      delete d.dataset.wio;
      if (!isMode(saved)) d.dataset.mode = DEFAULT_MODE;
      return;
    }
    d.dataset.wio = "";
    return () => {
      // Al pasar a una app de área (Caja, Cobranzas…), no arrastrar los colores.
      if (/^\/(caja|cobranzas|administracion)(\/|$)/.test(location.pathname)) delete d.dataset.wio;
    };
  }, [custom]);
  return null;
}
