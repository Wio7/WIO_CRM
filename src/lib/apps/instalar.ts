// Botón "Instalar app" de las apps de área (Cobranzas, Administración...).
// Chrome en Android y en laptop ofrece su propio aviso (beforeinstallprompt)
// cuando la página tiene manifiesto y service worker; si no llega ese aviso
// (o en iPhone, donde no existe), se muestran los pasos a mano.

import { isAppleMobile } from "@/lib/install-hint";

export type PlataformaInstalar = "iphone" | "android" | "laptop";

export function plataformaInstalar(userAgent: string, maxTouchPoints: number): PlataformaInstalar {
  if (isAppleMobile(userAgent, maxTouchPoints)) return "iphone";
  if (/Android/i.test(userAgent)) return "android";
  return "laptop";
}

export const PASOS_INSTALAR: Record<PlataformaInstalar, readonly string[]> = {
  iphone: [
    "Abre esta página en Safari.",
    "Toca el botón ••• (o el ícono Compartir, el cuadrado con la flecha hacia arriba).",
    "Toca Compartir y después Agregar a pantalla de inicio (puede decir Agregar a inicio).",
    "Deja activado Abrir como app web y toca Agregar.",
    "Entra siempre desde el nuevo ícono de tu pantalla de inicio.",
  ],
  android: [
    "Abre esta página en Chrome.",
    "Toca el menú ⋮ (arriba a la derecha).",
    "Toca Instalar app (o Agregar a pantalla principal) y confirma.",
    "Entra siempre desde el nuevo ícono de tu pantalla principal.",
  ],
  laptop: [
    "Abre esta página en Chrome o Edge.",
    "Toca el ícono de instalar a la derecha de la barra de direcciones, o el menú ⋮ → Transmitir, guardar y compartir → Instalar página como app.",
    "Confirma con Instalar: queda en el escritorio y en el menú de inicio.",
  ],
};
