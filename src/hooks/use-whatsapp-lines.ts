"use client";

// Líneas de WhatsApp de la cuenta, sin tokens, desde GET /api/whatsapp/config?lines_only=1.
// Una sola petición compartida entre todos los componentes (lista, hilo,
// aviso de conexión) con caché corta en memoria. El navegador nunca lee
// whatsapp_config directamente. invalidateWhatsappLines() (la pantalla de
// ajustes lo llama tras cada cambio) avisa a los componentes montados, que
// vuelven a pedir las líneas sin remontarse.

import { useEffect, useState } from "react";
import type { LineView } from "@/lib/whatsapp/lines-view";
import { isStaleLinesResponse } from "@/lib/inbox/line-filter";

const TTL_MS = 60_000;

let cache: { lines: LineView[]; at: number } | null = null;
let inflight: Promise<LineView[]> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

async function fetchLines(): Promise<LineView[]> {
  // lines_only: solo las líneas, sin verificar en Meta (esto corre cada 60 s por pestaña).
  const res = await fetch("/api/whatsapp/config?lines_only=1", { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  return Array.isArray(payload?.lines) ? (payload.lines as LineView[]) : [];
}

function load(): Promise<LineView[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.lines);
  if (!inflight) {
    const started = generation;
    const p: Promise<LineView[]> = fetchLines()
      .then((lines) => {
        // Respuesta anterior a una invalidación: no se guarda; se vuelve a pedir.
        if (isStaleLinesResponse(started, generation)) return load();
        cache = { lines, at: Date.now() };
        return lines;
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
  }
  return inflight;
}

/** Olvida la caché y avisa a los componentes montados para que recarguen. */
export function invalidateWhatsappLines() {
  generation += 1;
  cache = null;
  inflight = null;
  listeners.forEach((fn) => fn());
}

export function useWhatsappLines(): { lines: LineView[]; loading: boolean; error: boolean } {
  const [state, setState] = useState<{ lines: LineView[]; loading: boolean; error: boolean }>(() => ({
    lines: cache?.lines ?? [],
    loading: !cache,
    error: false,
  }));

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      load()
        .then((lines) => {
          if (!cancelled) setState({ lines, loading: false, error: false });
        })
        .catch(() => {
          // Sin líneas: la bandeja se ve como con una sola y el aviso no sale.
          if (!cancelled) setState((s) => ({ lines: s.lines, loading: false, error: true }));
        });
    };
    run();
    listeners.add(run);
    return () => {
      cancelled = true;
      listeners.delete(run);
    };
  }, []);

  return state;
}
