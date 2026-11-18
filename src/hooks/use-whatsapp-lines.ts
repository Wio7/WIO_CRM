"use client";

// Líneas de WhatsApp de la cuenta, sin tokens, desde GET /api/whatsapp/config.
// Una sola petición compartida entre todos los componentes (lista, hilo,
// aviso de conexión) con caché corta en memoria. El navegador nunca lee
// whatsapp_config directamente.

import { useEffect, useState } from "react";
import type { LineView } from "@/lib/whatsapp/lines-view";

const TTL_MS = 60_000;

let cache: { lines: LineView[]; at: number } | null = null;
let inflight: Promise<LineView[]> | null = null;

async function fetchLines(): Promise<LineView[]> {
  const res = await fetch("/api/whatsapp/config", { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  return Array.isArray(payload?.lines) ? (payload.lines as LineView[]) : [];
}

function load(): Promise<LineView[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.lines);
  if (!inflight) {
    inflight = fetchLines()
      .then((lines) => {
        cache = { lines, at: Date.now() };
        return lines;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Olvida la caché (p. ej. tras agregar o quitar una línea). */
export function invalidateWhatsappLines() {
  cache = null;
}

export function useWhatsappLines(): { lines: LineView[]; loading: boolean } {
  const [state, setState] = useState<{ lines: LineView[]; loading: boolean }>(() => ({
    lines: cache?.lines ?? [],
    loading: !cache,
  }));

  useEffect(() => {
    let cancelled = false;
    load()
      .then((lines) => {
        if (!cancelled) setState({ lines, loading: false });
      })
      .catch(() => {
        // Sin líneas: la bandeja se ve como con una sola.
        if (!cancelled) setState((s) => ({ lines: s.lines, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
