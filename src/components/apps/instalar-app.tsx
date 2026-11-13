"use client";

// "Instalar app" para las apps de área. Registra el service worker con el
// scope de la app; si Chrome entrega su aviso de instalación, el botón lo
// abre; si no (iPhone, o Chrome todavía no lo ofrece), muestra los pasos.
// Se oculta cuando la app ya se abrió instalada.

import { useEffect, useState, useSyncExternalStore } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EVENTO_INSTALABLE } from "@/components/apps/captura-instalar";
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

type VentanaInstalar = Window & { __avisoInstalar?: AvisoInstalar | null; __appInstalada?: boolean };

// Lo que dejó el script temprano (CapturaInstalar): el aviso de Chrome, si llegó.
function suscribir(cambio: () => void) {
  window.addEventListener(EVENTO_INSTALABLE, cambio);
  return () => window.removeEventListener(EVENTO_INSTALABLE, cambio);
}
const leerAviso = () => (window as VentanaInstalar).__avisoInstalar ?? null;
const leerInstalada = () => abiertaComoApp() || (window as VentanaInstalar).__appInstalada === true;

export function useInstalarApp(scope: string | undefined) {
  // En el servidor: sin aviso y "instalada", así el HTML y la hidratación coinciden.
  const aviso = useSyncExternalStore(suscribir, leerAviso, () => null);
  const yaInstalada = useSyncExternalStore(suscribir, leerInstalada, () => true);
  const [aceptada, setAceptada] = useState(false);
  const [pasos, setPasos] = useState<PlataformaInstalar | null>(null);
  const visible = Boolean(scope) && !yaInstalada && !aceptada;

  // Respaldo por si la página llegó sin el script temprano (navegación interna).
  useEffect(() => {
    if (!scope || abiertaComoApp() || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/app-sw.js", { scope }).catch(() => {
      // Sin service worker igual quedan los pasos a mano.
    });
  }, [scope]);

  async function instalar() {
    if (aviso) {
      await aviso.prompt();
      const { outcome } = await aviso.userChoice;
      (window as VentanaInstalar).__avisoInstalar = null;
      window.dispatchEvent(new Event(EVENTO_INSTALABLE));
      if (outcome === "accepted") setAceptada(true);
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
