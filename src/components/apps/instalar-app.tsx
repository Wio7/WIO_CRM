"use client";

// "Instalar app" para las apps de área. Registra el service worker con el
// scope de la app; si Chrome entrega su aviso de instalación, el botón lo
// abre; si no (iPhone, o Chrome todavía no lo ofrece), muestra los pasos.
// Se oculta cuando la app ya se abrió instalada.

import { useEffect, useState, useSyncExternalStore } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PASOS_INSTALAR, plataformaInstalar, type PlataformaInstalar } from "@/lib/apps/instalar";

interface AvisoInstalar extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function abiertaComoApp(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// Nada a qué suscribirse: si está instalada solo cambia en la próxima visita.
const sinSuscripcion = () => () => {};

export function useInstalarApp(scope: string | undefined) {
  // false en el servidor, así el HTML del servidor y la hidratación coinciden.
  const enNavegador = useSyncExternalStore(sinSuscripcion, () => !abiertaComoApp(), () => false);
  const [instalada, setInstalada] = useState(false);
  const [aviso, setAviso] = useState<AvisoInstalar | null>(null);
  const [pasos, setPasos] = useState<PlataformaInstalar | null>(null);
  const visible = Boolean(scope) && enNavegador && !instalada;

  useEffect(() => {
    if (!scope || abiertaComoApp()) return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/app-sw.js", { scope }).catch(() => {
        // Sin service worker igual quedan los pasos a mano.
      });
    }
    const alAviso = (e: Event) => {
      e.preventDefault();
      setAviso(e as AvisoInstalar);
    };
    const alInstalar = () => {
      setInstalada(true);
      setAviso(null);
    };
    window.addEventListener("beforeinstallprompt", alAviso);
    window.addEventListener("appinstalled", alInstalar);
    return () => {
      window.removeEventListener("beforeinstallprompt", alAviso);
      window.removeEventListener("appinstalled", alInstalar);
    };
  }, [scope]);

  async function instalar() {
    if (aviso) {
      await aviso.prompt();
      const { outcome } = await aviso.userChoice;
      setAviso(null);
      if (outcome === "accepted") setInstalada(true);
      return;
    }
    setPasos(plataformaInstalar(navigator.userAgent, navigator.maxTouchPoints ?? 0));
  }

  return { visible, instalar, pasos, cerrarPasos: () => setPasos(null) };
}

export function PasosInstalar({
  nombre,
  pasos,
  onClose,
}: {
  nombre: string;
  pasos: PlataformaInstalar | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={pasos !== null} onOpenChange={(abierto) => !abierto && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Instala {nombre}</DialogTitle>
          <DialogDescription>Queda como una app con su ícono y se abre a pantalla completa.</DialogDescription>
        </DialogHeader>
        {pasos && (
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {PASOS_INSTALAR[pasos].map((paso) => (
              <li key={paso}>{paso}</li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
