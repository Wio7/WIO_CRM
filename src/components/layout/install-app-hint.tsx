"use client";

import { useState, useSyncExternalStore } from "react";
import { Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shouldShowInstallHint } from "@/lib/install-hint";

const STORAGE_KEY = "wio:install-hint-snoozed-at";

// Steps for iOS 26 Safari; older versions show the Share icon directly
// in the toolbar, which the first step also mentions.
const STEPS = [
  "Abre esta página en Safari.",
  "Toca el botón ••• (o el ícono Compartir, el cuadrado con la flecha hacia arriba).",
  "Toca Compartir y después Agregar a pantalla de inicio (puede decir Agregar a inicio).",
  "Deja activado Abrir como app web y toca Agregar.",
  "Entra siempre desde el nuevo ícono de tu pantalla de inicio.",
];

function readShouldShow(): boolean {
  let snoozedAt: number | null = null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    snoozedAt = raw ? Number(raw) : null;
  } catch {
    // Storage blocked (private mode): just show the hint.
  }
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return shouldShowInstallHint({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone,
    snoozedAt: Number.isFinite(snoozedAt) ? snoozedAt : null,
    now: Date.now(),
  });
}

// Nothing to subscribe to: the answer only changes on the next visit.
const noSubscription = () => () => {};

/** Banner with the iPhone install steps; renders nothing elsewhere. */
export function InstallAppHint({ appName }: { appName: string }) {
  // false on the server, so the server HTML and hydration always agree.
  const eligible = useSyncExternalStore(noSubscription, readShouldShow, () => false);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);

  if (!eligible || dismissed) return null;

  function snooze() {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // Nothing to persist; it just shows again next visit.
    }
    setDismissed(true);
  }

  return (
    <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <div className="flex items-start gap-3">
        <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">Instala {appName} en tu iPhone</p>
          <p className="text-xs text-muted-foreground">
            Queda como una app en tu pantalla de inicio y se abre a pantalla completa.
          </p>
          {open && (
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-xs text-foreground">
              {STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {!open && (
              <Button size="sm" onClick={() => setOpen(true)}>
                Ver cómo
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={snooze}>
              Ahora no
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={snooze}
          aria-label="Cerrar"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
